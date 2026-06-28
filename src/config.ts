import { join } from "node:path";
import { isLoggedIn } from "./auth";

export type DwiwConfig = {
	proposalUx: "inline" | "menu";
	autoRun: boolean;
	destructiveGuard: boolean;
	confirmAll: boolean;
	provider: string;
	model: string;
	plugins: string[];
};

const CODEX_MODEL = "gpt-5.4-mini";
const ANTHROPIC_MODEL = "claude-haiku-4-5";

export async function loadConfig(): Promise<DwiwConfig> {
	const defaults: DwiwConfig = {
		proposalUx: "inline",
		autoRun: true,
		destructiveGuard: true,
		confirmAll: false,
		provider: Bun.env.DWIW_PROVIDER ?? "",
		model: Bun.env.DWIW_MODEL ?? "",
		plugins: (Bun.env.DWIW_PLUGINS ?? "").split(":").filter(Boolean),
	};
	let config = defaults;
	try {
		const file = await Bun.file(
			join(Bun.env.HOME ?? ".", ".dwiw", "config.json"),
		).json();
		config = { ...defaults, ...file };
	} catch {}

	// When no provider is pinned, pick one automatically: Codex once signed in
	// (so `dwiw login` is all it takes), else Anthropic if a key is present,
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

export function needsConfirm(command: string, config: DwiwConfig) {
	if (config.confirmAll) return true;
	return (
		config.destructiveGuard &&
		/\b(rm\s+-rf|dd\s+if=|git\s+push\s+.*--force|>\s*\/dev\/)/.test(command)
	);
}
