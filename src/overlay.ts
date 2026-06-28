import { closeSync, read, writeSync } from "node:fs";
import { createBrainClient } from "./brain-client";
import { loadConfig, needsConfirm } from "./config";
import { AgentJobs } from "./jobs";
import { buildContext, loadPlugins } from "./plugins";
import { openPty } from "./pty";
import { createResolutionTable } from "./resolution";
import { routeLine } from "./router";

export async function runOverlay() {
	const shell = Bun.env.SHELL ?? "/bin/sh";
	if (!Bun.which("script")) {
		console.error(
			"dwim: the 'script' command is required to wrap your shell but was not found.",
		);
		process.exit(1);
	}
	const table = await createResolutionTable();
	const config = await loadConfig();
	const brain = createBrainClient({
		provider: config.provider,
		model: config.model,
	});
	const plugins = await loadPlugins(config.plugins);
	const jobs = new AgentJobs();
	const history: string[] = [];
	let line = "";
	let output = "";
	let childActive = false;
	let pendingRun: string | null = null;

	const { master, slave } = openPty(
		process.stdout.rows ?? 24,
		process.stdout.columns ?? 80,
	);
	// Run the shell under `script` so it gets a real *controlling* terminal
	// (setsid + login_tty): job control, tcsetpgrp, and multiplexers like
	// herdr/tmux all need this. We hand `script` the pty slave — a genuine tty,
	// so its tcgetattr succeeds where a pipe failed — and drive the master end.
	const child = Bun.spawn(
		process.platform === "linux"
			? ["script", "-qfc", shell, "/dev/null"]
			: ["script", "-q", "/dev/null", shell],
		{
			cwd: process.cwd(),
			env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
			stdin: slave,
			stdout: slave,
			stderr: slave,
		},
	);
	closeSync(slave);
	const writeChild = (data: string) => {
		writeSync(master, data);
	};

	// Restore the terminal and tear down children on any exit path — otherwise
	// quitting leaves the parent terminal stuck in raw mode.
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		try {
			process.stdin.setRawMode?.(false);
		} catch {}
		brain.close();
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

	// Mirror the pty master to our stdout, watching for the child entering or
	// leaving the alternate screen (vim, less, ssh+TUI) so we pass keystrokes
	// straight through instead of routing them to the brain.
	const readBuffer = Buffer.alloc(65536);
	const onMaster = (err: Error | null, bytes: number) => {
		if (err || bytes <= 0) {
			cleanup();
			process.exit(0);
			return;
		}
		const data = readBuffer.toString("utf8", 0, bytes);
		if (
			data.includes("[?1049h") ||
			data.includes("[?1047h") ||
			data.includes("[?47h")
		)
			childActive = true;
		if (
			data.includes("[?1049l") ||
			data.includes("[?1047l") ||
			data.includes("[?47l")
		)
			childActive = false;
		output = (output + data).slice(-12000);
		process.stdout.write(Buffer.from(readBuffer.subarray(0, bytes)));
		read(master, readBuffer, 0, readBuffer.length, null, onMaster);
	};
	read(master, readBuffer, 0, readBuffer.length, null, onMaster);

	process.stdin.on("data", async (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		if (text === "\u0003" || text === "\u0004" || text === "\u001a") {
			writeChild(text);
			return;
		}
		if (text === "\r") {
			if (handleInternalCommand(line, jobs, writeChild)) {
				line = "";
				return;
			}
			const decision = routeLine(line, table, childActive);

			// Ambiguous = resolves but reads like prose. Never auto-run, never send
			// it to the brain. First Enter holds the line; a second Enter runs it.
			if (decision.kind === "ambiguous" && pendingRun !== line) {
				pendingRun = line;
				process.stdout.write(
					`\n⚠ dwim: ambiguous — Enter again to run as a command, or edit the line.\n`,
				);
				return;
			}
			pendingRun = null;
			history.push(line);
			await Promise.all(
				plugins.map((plugin) =>
					plugin.observeShellEvent?.({ type: "command", value: line }),
				),
			);
			if (decision.kind === "intent") {
				writeChild("\u0015");
				process.stdout.write("\r\n");
				const context = await buildContext(
					{ cwd: process.cwd(), history, lastOutput: output },
					plugins,
				);
				const request = {
					type: "prompt" as const,
					message: decision.line,
					context,
					mode: decision.mode,
				};
				if (decision.mode === "agent") {
					const job = jobs.start(decision.line);
					line = "";
					process.stdout.write(`[dwim ${job.id}] started\n`);
					brain
						.ask(request, async (event) => {
							if (event.type === "text") jobs.append(job.id, event.text);
							if (event.type === "proposal") jobs.append(job.id, event.command);
							if (event.type === "error") jobs.finish(job.id, "error");
							if (event.type === "done") {
								jobs.finish(job.id);
								process.stdout.write(
									`\n[dwim ${job.id}] done; run dwim fg ${job.id}\n`,
								);
							}
						})
						.catch((error) => {
							jobs.finish(job.id, "error");
							process.stdout.write(
								`\n[dwim ${job.id}] error: ${error instanceof Error ? error.message : String(error)}\n`,
							);
						});
					return;
				}
				await brain.ask(request, async (event) => {
					if (event.type === "text") process.stdout.write(event.text);
					if (event.type === "proposal") {
						const command = await applyPostProcess(event.command, plugins);
						if (needsConfirm(command, config))
							process.stdout.write(
								`⚠ dwim: review this command before running.\n`,
							);
						line = command;
						writeChild(line);
					}
					if (event.type === "error")
						process.stdout.write(`dwim error: ${event.message}\n`);
				});
				return;
			}
			line = "";
			writeChild("\r");
			await table.refresh();
			return;
		}
		if (text === "\u007f") line = line.slice(0, -1);
		else if (!text.startsWith("\u001b")) line += text;
		writeChild(text);
	});
}

function handleInternalCommand(
	line: string,
	jobs: AgentJobs,
	write: (data: string) => void,
) {
	const trimmed = line.trim();
	if (trimmed === "dwim jobs") {
		write("\u0015");
		process.stdout.write(
			`\r\n${jobs
				.list()
				.map((job) => `[${job.id}] ${job.status} ${job.prompt}`)
				.join("\n")}\n`,
		);
		return true;
	}
	const match = trimmed.match(/^dwim fg (\d+)$/);
	if (match) {
		write("\u0015");
		const job = jobs.get(Number(match[1]));
		process.stdout.write(`\r\n${job?.output ?? "no such dwim job"}\n`);
		return true;
	}
	return false;
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
