import { createBrain } from "./brain";
import { loadConfig, needsConfirm } from "./config";
import { AgentJobs } from "./jobs";
import { loadPlugins } from "./plugins";
import type { ShellContext } from "./protocol";
import { createResolutionTable } from "./resolution";
import { routeLine } from "./router";

export async function runOverlay() {
	const shell = Bun.env.SHELL ?? "/bin/sh";
	const table = await createResolutionTable();
	const config = await loadConfig();
	const brain = createBrain({ provider: config.provider, model: config.model });
	const plugins = await loadPlugins(config.plugins);
	const jobs = new AgentJobs();
	const history: string[] = [];
	let line = "";
	let output = "";
	const childActive = false;

	const child = Bun.spawn(["script", "-q", "/dev/null", shell], {
		cwd: process.cwd(),
		env: process.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	process.stdin.setRawMode?.(true);
	process.stdin.resume();
	pump(child.stdout, (data) => {
		output = (output + data).slice(-12000);
		process.stdout.write(data);
	});
	pump(child.stderr, (data) => process.stderr.write(data));
	child.exited.then(() => process.exit(0));

	process.stdin.on("data", async (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		if (text === "\u0003" || text === "\u0004" || text === "\u001a") {
			child.stdin.write(text);
			return;
		}
		if (text === "\r") {
			if (handleInternalCommand(line, jobs, child.stdin)) {
				line = "";
				return;
			}
			const decision = routeLine(line, table, childActive);
			history.push(line);
			await Promise.all(
				plugins.map((plugin) =>
					plugin.observeShellEvent?.({ type: "command", value: line }),
				),
			);
			if (decision.kind === "intent" || decision.kind === "ambiguous") {
				child.stdin.write("\u0015");
				process.stdout.write("\r\n");
				const context: ShellContext = {
					cwd: process.cwd(),
					history,
					lastOutput: output,
				};
				const mode = decision.kind === "intent" ? decision.mode : "auto";
				const request = {
					type: "prompt" as const,
					message: decision.line,
					context,
					mode,
				};
				if (mode === "agent") {
					const job = jobs.start(decision.line);
					process.stdout.write(`[dwim ${job.id}] started\n`);
					brain.ask(request, async (event) => {
						if (event.type === "text") jobs.append(job.id, event.text);
						if (event.type === "proposal") jobs.append(job.id, event.command);
						if (event.type === "error") jobs.finish(job.id, "error");
						if (event.type === "done") {
							jobs.finish(job.id);
							process.stdout.write(
								`\n[dwim ${job.id}] done; run dwim fg ${job.id}\n`,
							);
						}
					});
					return;
				}
				await brain.ask(request, async (event) => {
					if (event.type === "text") process.stdout.write(event.text);
					if (event.type === "proposal") {
						const command = await applyPostProcess(event.command, plugins);
						line = needsConfirm(command, config)
							? `# confirm: ${command}`
							: command;
						child.stdin.write(line);
					}
					if (event.type === "error")
						process.stdout.write(`dwim error: ${event.message}\n`);
				});
				return;
			}
			line = "";
			child.stdin.write("\r");
			await table.refresh();
			return;
		}
		if (text === "\u007f") line = line.slice(0, -1);
		else if (!text.startsWith("\u001b")) line += text;
		child.stdin.write(text);
	});
}

function handleInternalCommand(
	line: string,
	jobs: AgentJobs,
	stdin: { write: (data: string) => void },
) {
	const trimmed = line.trim();
	if (trimmed === "dwim jobs") {
		stdin.write("\u0015");
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
		stdin.write("\u0015");
		const job = jobs.get(Number(match[1]));
		process.stdout.write(`\r\n${job?.output ?? "no such dwim job"}\n`);
		return true;
	}
	return false;
}

async function pump(
	stream: ReadableStream<Uint8Array>,
	write: (data: string) => void,
) {
	const decoder = new TextDecoder();
	for await (const chunk of stream) write(decoder.decode(chunk));
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
