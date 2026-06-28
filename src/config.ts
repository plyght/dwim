import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type DwimConfig = {
	proposalUx: "inline" | "menu";
	destructiveGuard: boolean;
	confirmAll: boolean;
	provider: string;
	model: string;
	plugins: string[];
};

export async function loadConfig(): Promise<DwimConfig> {
	const defaults: DwimConfig = {
		proposalUx: "inline",
		destructiveGuard: false,
		confirmAll: false,
		provider: Bun.env.DWIM_PROVIDER ?? "",
		model: Bun.env.DWIM_MODEL ?? "",
		plugins: (Bun.env.DWIM_PLUGINS ?? "").split(":").filter(Boolean),
	};
	try {
		const file = await readFile(
			join(Bun.env.HOME ?? ".", ".dwim", "config.json"),
			"utf8",
		);
		return { ...defaults, ...JSON.parse(file) };
	} catch {
		return defaults;
	}
}

export function needsConfirm(command: string, config: DwimConfig) {
	if (config.confirmAll) return true;
	return (
		config.destructiveGuard &&
		/\b(rm\s+-rf|dd\s+if=|git\s+push\s+.*--force|>\s*\/dev\/)/.test(command)
	);
}
