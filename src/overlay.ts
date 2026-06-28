import { closeSync, read, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createBrainClient } from "./brain-client";
import { loadConfig, needsConfirm } from "./config";
import { type IpcConn, type IpcRequest, serveIpc } from "./ipc";
import { AgentJobs } from "./jobs";
import { buildContext, loadPlugins } from "./plugins";
import { openPty } from "./pty";
import { createResolutionTable } from "./resolution";
import { routeLine } from "./router";

const INTEGRATION_SOURCE = await Bun.file(
	new URL("./integration.fish", import.meta.url),
).text();

export async function runOverlay() {
	const shell = Bun.env.SHELL ?? "/bin/sh";
	const shellName = basename(shell);
	if (!Bun.which("script")) {
		console.error(
			"dwiw: the 'script' command is required to wrap your shell but was not found.",
		);
		process.exit(1);
	}
	if (shellName !== "fish") {
		console.error(
			`dwiw: only fish is supported right now (your shell is ${shellName}). Starting a plain wrapped shell without AI routing.`,
		);
	}

	const dwiwDir = join(Bun.env.HOME ?? ".", ".dwiw");
	await mkdir(dwiwDir, { recursive: true });
	const integrationPath = join(dwiwDir, "integration.fish");
	await writeFile(integrationPath, INTEGRATION_SOURCE);
	const sockPath = join(dwiwDir, `sock-${process.pid}.sock`);
	try {
		const { unlinkSync } = await import("node:fs");
		unlinkSync(sockPath);
	} catch {}

	const table = await createResolutionTable();
	const config = await loadConfig();
	const brain = createBrainClient({
		provider: config.provider,
		model: config.model,
	});
	const plugins = await loadPlugins(config.plugins);
	const jobs = new AgentJobs();
	const history: string[] = [];
	const conversation: { role: "user" | "assistant"; text: string }[] = [];
	let lastOutput = "";
	let lastExitCode: number | undefined;

	// The router and brain live here; the in-shell binding asks over the socket.
	async function handleAsk(req: { line: string; cwd: string }, conn: IpcConn) {
		const decision = routeLine(req.line, table, false);
		const message = decision.kind === "intent" ? decision.line : req.line;
		const mode = decision.kind === "intent" ? decision.mode : "auto";
		const context = await buildContext(
			{ cwd: req.cwd, history, lastOutput, lastExitCode, conversation },
			plugins,
		);
		const request = {
			type: "prompt" as const,
			message,
			context,
			mode,
		};
		await Promise.all(
			plugins.map((plugin) =>
				plugin.observeShellEvent?.({ type: "command", value: message }),
			),
		);
		if (mode === "agent") {
			const job = jobs.start(message);
			conn.send({
				out: `[dwiw ${job.id}] started — run dwiw fg ${job.id} when ready\n`,
			});
			conn.send({ result: { action: "chat" } });
			conn.close();
			brain
				.ask(request, async (event) => {
					if (event.type === "text") jobs.append(job.id, event.text);
					if (event.type === "agent_action")
						jobs.append(
							job.id,
							`[${event.label}]${event.detail ? ` ${event.detail}` : ""}\n`,
						);
					if (event.type === "proposal") {
						jobs.propose(job.id, event.command);
						jobs.append(job.id, `${event.command}\n`);
					}
					if (event.type === "error") jobs.finish(job.id, "error");
					if (event.type === "done") jobs.finish(job.id);
				})
				.catch(() => jobs.finish(job.id, "error"));
			return;
		}
		let proposal: string | undefined;
		let rawProposal: string | undefined;
		let chatText = "";
		let settled = false;
		const startedAt = Date.now();
		const eventLog: string[] = [];
		const debug = (note: string) => {
			if (!Bun.env.DWIW_DEBUG) return;
			void writeFile(
				join(dwiwDir, "debug.log"),
				`${new Date().toISOString()} ${note}\n`,
				{ flag: "a" },
			).catch(() => {});
		};
		const finalize = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			debug(
				`ask "${message}" mode=${mode} ms=${Date.now() - startedAt} events=[${eventLog.join(",")}] proposal=${JSON.stringify(proposal)} chatLen=${chatText.length}`,
			);
			conversation.push({ role: "user", text: message });
			if (proposal?.trim()) {
				conversation.push({ role: "assistant", text: `proposed: ${proposal}` });
				const guard = needsConfirm(proposal, config);
				if (guard)
					conn.send({ out: "⚠ dwiw: review this command before running.\n" });
				conn.send({
					result: {
						action: config.autoRun && !guard ? "run" : "edit",
						command: proposal,
					},
				});
			} else if (chatText.trim()) {
				conversation.push({ role: "assistant", text: chatText.trim() });
				conn.send({ result: { action: "chat" } });
			} else {
				conn.send({ out: "dwiw: no response from the model.\n" });
				conn.send({ result: { action: "chat" } });
			}
			conn.close();
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			debug(`ask "${message}" TIMEOUT events=[${eventLog.join(",")}]`);
			conn.send({ out: "dwiw: the model took too long; try again.\n" });
			conn.send({ result: { action: "chat" } });
			conn.close();
		}, 45000);
		try {
			await brain.ask(request, async (event) => {
				if (settled) return;
				eventLog.push(event.type);
				if (event.type === "text") {
					chatText += event.text;
					conn.send({ out: event.text });
				}
				if (event.type === "agent_action")
					conn.send({
						out: `[${event.label}]${event.detail ? ` ${event.detail}` : ""}\n`,
					});
				if (event.type === "proposal") rawProposal = event.command;
				if (event.type === "error")
					conn.send({ out: `dwiw error: ${event.message}\n` });
			});
			if (rawProposal) proposal = await applyPostProcess(rawProposal, plugins);
			finalize();
		} catch (error) {
			if (!settled) {
				debug(`ask "${message}" THREW ${String(error)}`);
				conn.send({
					out: `dwiw error: ${error instanceof Error ? error.message : String(error)}\n`,
				});
				settled = true;
				clearTimeout(timer);
				conn.send({ result: { action: "chat" } });
				conn.close();
			}
		}
	}

	const server = serveIpc(sockPath, (request: IpcRequest, conn) => {
		if (request.op === "route") {
			const decision = routeLine(request.line, table, false);
			if (decision.kind === "intent" || decision.kind === "command")
				history.push(decision.line);
			const kind = decision.kind === "passthrough" ? "command" : decision.kind;
			conn.send({ kind, line: decision.line });
			conn.close();
			return;
		}
		if (request.op === "ask") {
			void handleAsk(request, conn);
			return;
		}
		if (request.op === "jobs") {
			conn.send({
				jobs: jobs.list().map((job) => ({
					id: job.id,
					status: job.status,
					prompt: job.prompt,
				})),
			});
			conn.close();
			return;
		}
		if (request.op === "fg") {
			const job = jobs.get(request.id);
			conn.send(
				job
					? { output: job.output, proposal: job.proposal }
					: { output: "no such dwiw job" },
			);
			conn.close();
		}
	});

	const { master, slave } = openPty(
		process.stdout.rows ?? 24,
		process.stdout.columns ?? 80,
	);
	// Run the shell under `script` so it gets a real *controlling* terminal
	// (setsid + login_tty): job control, tcsetpgrp, and multiplexers like
	// herdr/tmux all need this. We hand `script` the pty slave — a genuine tty,
	// so its tcgetattr succeeds where a pipe failed — and drive the master end.
	// Load the integration via fish's --init-command so the Enter binding is
	// installed *before* the first prompt and without echoing a visible `source`
	// line. Non-fish shells just get a plain wrapped shell.
	const initCmd = `source '${integrationPath}'`;
	const fishInit = shellName === "fish";
	const argv =
		process.platform === "linux"
			? [
					"script",
					"-qfc",
					fishInit ? `${shell} --init-command "${initCmd}"` : shell,
					"/dev/null",
				]
			: fishInit
				? ["script", "-q", "/dev/null", shell, "--init-command", initCmd]
				: ["script", "-q", "/dev/null", shell];
	const child = Bun.spawn(argv, {
		cwd: process.cwd(),
		env: {
			...process.env,
			TERM: process.env.TERM ?? "xterm-256color",
			DWIW_SOCK: sockPath,
			DWIW_EXEC: process.execPath,
			DWIW_SCRIPT: Bun.argv[1]?.endsWith(".ts") ? resolve(Bun.argv[1]) : "",
		},
		stdin: slave,
		stdout: slave,
		stderr: slave,
	});
	closeSync(slave);
	const writeChild = (data: string | Buffer) => {
		if (typeof data === "string") writeSync(master, data);
		else writeSync(master, data);
	};

	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		try {
			process.stdin.setRawMode?.(false);
		} catch {}
		brain.close();
		server.stop();
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(sockPath);
		} catch {}
		child.kill();
		try {
			closeSync(master);
		} catch {}
	};
	child.exited.then(() => {
		cleanup();
		process.exit(0);
	});
	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});

	process.stdin.setRawMode?.(true);
	process.stdin.resume();

	// Mirror the pty master to stdout, stripping the OSC 133 prompt markers our
	// fish integration emits while recording the prompt state and exit codes.
	const readBuffer = Buffer.alloc(65536);
	const onMaster = (err: Error | null, bytes: number) => {
		if (err || bytes <= 0) {
			cleanup();
			process.exit(0);
			return;
		}
		const data = readBuffer.toString("utf8", 0, bytes);
		const marker = osc133Marker();
		let match = marker.exec(data);
		while (match) {
			if (match[1] === "D" && match[2])
				lastExitCode = Number(match[2].slice(1));
			match = marker.exec(data);
		}
		const cleanedData = data.replace(marker, "");
		lastOutput = (lastOutput + cleanedData).slice(-12000);
		process.stdout.write(cleanedData);
		read(master, readBuffer, 0, readBuffer.length, null, onMaster);
	};
	read(master, readBuffer, 0, readBuffer.length, null, onMaster);

	process.stdin.on("data", (chunk: Buffer) => {
		writeChild(chunk);
	});
}

function osc133Marker() {
	const esc = String.fromCharCode(27);
	const bel = String.fromCharCode(7);
	return new RegExp(
		`${esc}\\]133;([A-D])(;[^${bel}${esc}]*)?(?:${bel}|${esc}\\\\)`,
		"g",
	);
}

async function applyPostProcess(
	command: string,
	plugins: Awaited<ReturnType<typeof loadPlugins>>,
) {
	let next = command;
	for (const plugin of plugins)
		next = (await plugin.postProcessProposal?.(next)) ?? next;
	return next;
}
