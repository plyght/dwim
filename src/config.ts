import { join } from "node:path";
import { isLoggedIn } from "./auth";

export type DwimConfig = {
	proposalUx: "inline" | "menu";
	autoRun: boolean;
	destructiveGuard: boolean;
	confirmAll: boolean;
	provider: string;
	model: string;
	plugins: string[];
};

const CODEX_MODEL = "gpt-5.4";
const ANTHROPIC_MODEL = "claude-haiku-4-5";

export async function loadConfig(): Promise<DwimConfig> {
	const defaults: DwimConfig = {
		proposalUx: "inline",
		autoRun: true,
		destructiveGuard: true,
		confirmAll: false,
		provider: Bun.env.DWIM_PROVIDER ?? "",
		model: Bun.env.DWIM_MODEL ?? "",
		plugins: (Bun.env.DWIM_PLUGINS ?? "").split(":").filter(Boolean),
	};
	let config = defaults;
	try {
		const file = await Bun.file(
			join(Bun.env.HOME ?? ".", ".dwim", "config.json"),
		).json();
		config = { ...defaults, ...file };
	} catch {}

	// When no provider is pinned, pick one automatically: Codex once signed in
	// (so `dwim login` is all it takes), else Anthropic if a key is present,
	// else nothing — which falls back to the offline heuristic.
	if (!config.provider) {
		if (await isLoggedIn()) {
			config.provider = "openai-codex";
			config.model ||= CODEX_MODEL;
		} else if (Bun.env.ANTHROPIC_API_KEY) {
			config.provider = "anthropic";
			config.model ||= ANTHROPIC_MODEL;
		}
	}
	return config;
}

export function needsConfirm(command: string, config: DwimConfig) {
	if (config.confirmAll) return true;
	return (
		config.destructiveGuard &&
		/\b(rm\s+-rf|dd\s+if=|git\s+push\s+.*--force|>\s*\/dev\/)/.test(command)
	);
}
