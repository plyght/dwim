import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShellContext } from "./protocol";

export type DwiwPlugin = {
	name: string;
	injectContext?: (
		context: ShellContext,
	) =>
		| Promise<Record<string, unknown> | undefined>
		| Record<string, unknown>
		| undefined;
	observeShellEvent?: (event: {
		type: "command" | "output" | "exit";
		value: string;
	}) => void | Promise<void>;
	postProcessProposal?: (command: string) => string | Promise<string>;
};

export async function loadPlugins(paths: string[]): Promise<DwiwPlugin[]> {
	const plugins: DwiwPlugin[] = [shellContextPlugin(), memoryPlugin()];
	for (const path of paths) {
		const mod = await import(path);
		const plugin = mod.default ?? mod.plugin;
		if (plugin?.name) plugins.push(plugin);
	}
	return plugins;
}

export async function buildContext(
	context: ShellContext,
	plugins: DwiwPlugin[],
): Promise<ShellContext> {
	let memory: string[] = [];
	for (const plugin of plugins) {
		const value = await plugin.injectContext?.(context);
		if (value && Array.isArray((value as { facts?: unknown }).facts))
			memory = (value as { facts: string[] }).facts;
	}
	return {
		cwd: context.cwd,
		history: context.history.slice(-20).map(redact),
		lastOutput: redact(context.lastOutput).slice(-8000),
		lastExitCode: context.lastExitCode,
		memory,
		conversation: (context.conversation ?? []).slice(-8).map((turn) => ({
			role: turn.role,
			text: redact(turn.text),
		})),
	};
}

function shellContextPlugin(): DwiwPlugin {
	return {
		name: "shell-context",
		injectContext(context) {
			return {
				cwd: context.cwd,
				history: context.history.slice(-20).map(redact),
				lastOutput: redact(context.lastOutput).slice(-8000),
				lastExitCode: context.lastExitCode,
			};
		},
	};
}

function memoryPlugin(): DwiwPlugin {
	const dir = join(Bun.env.HOME ?? ".", ".dwiw");
	const file = join(dir, "memory.json");
	return {
		name: "memory",
		async injectContext() {
			try {
				return JSON.parse(await readFile(file, "utf8"));
			} catch {
				return { facts: [] };
			}
		},
		async observeShellEvent(event) {
			const match = event.value.match(/^remember\s+(.+)/i);
			if (!match) return;
			await mkdir(dir, { recursive: true });
			let facts: string[] = [];
			try {
				facts = JSON.parse(await readFile(file, "utf8")).facts ?? [];
			} catch {}
			facts.push(match[1] ?? "");
			await writeFile(file, JSON.stringify({ facts }, null, 2));
		},
	};
}

function redact(value: string) {
	return value
		.replace(
			/([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*=)[^\s]+/gi,
			"$1[redacted]",
		)
		.replace(/(?:sk|pk)-[A-Za-z0-9_-]{20,}/g, "[redacted]");
}
