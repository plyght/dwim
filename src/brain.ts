import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { getCodexToken } from "./auth";
import type { BrainEvent, BrainRequest } from "./protocol";

export type Brain = {
	ask: (
		request: BrainRequest,
		emit: (event: BrainEvent) => void,
	) => Promise<void>;
};

export type BrainOptions = { provider?: string; model?: Model<Api> | string };

export function createBrain(options: BrainOptions = {}): Brain {
	return {
		async ask(request, emit) {
			const command = await proposeCommand(request, options);
			emit({
				type: "proposal",
				command,
				explanation: "Review, edit if needed, then press Enter.",
			});
			emit({ type: "done" });
		},
	};
}

async function proposeCommand(request: BrainRequest, options: BrainOptions) {
	const model = resolveModel(options);
	if (!model) return heuristicProposal(request.message);
	const streamOptions: { maxTokens: number; apiKey?: string } = {
		maxTokens: 200,
	};
	if (options.provider === "openai-codex") {
		const token = await getCodexToken();
		if (!token) return heuristicProposal(request.message);
		streamOptions.apiKey = token;
	}
	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt:
					"You are dwim, a natural-language shell. Convert the user's request into ONE shell command to run on their real macOS/Linux machine. It has full internet access and standard tools (curl, jq, git, rg, find), so you CAN fetch things like weather, your IP, or web data — do not refuse. Output only the command: no markdown, no backticks, no prose, no apologies. Examples: 'weather in <city>' -> curl -fsSL 'wttr.in/<city>?format=3'; 'my ip' -> curl -fsSL ifconfig.me; 'biggest files here' -> du -ah . | sort -rh | head. Prefer Bun for JS/TS. Only output an echo with a short reason if the request is genuinely impossible as one shell command.",
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: `cwd: ${request.context.cwd}\nmemory: ${(request.context.memory ?? []).join("; ")}\nhistory: ${request.context.history.join("\n")}\nlast output: ${request.context.lastOutput.slice(-4000)}\nrequest: ${request.message}`,
					},
				],
			},
			streamOptions,
		);
		const text = response.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("")
			.trim();
		return sanitizeCommand(text) || heuristicProposal(request.message);
	} catch (error) {
		return `echo ${JSON.stringify(`dwim brain error: ${error instanceof Error ? error.message : String(error)}`)}`;
	}
}

function resolveModel(options: BrainOptions) {
	if (typeof options.model !== "string") return options.model;
	if (!options.model || !options.provider) return undefined;
	return getModel(
		options.provider as never,
		options.model as never,
	) as Model<Api>;
}

function sanitizeCommand(text: string) {
	return text
		.replace(/^```(?:sh|bash|shell)?/i, "")
		.replace(/```$/i, "")
		.split("\n")
		.find((line) => line.trim() && !line.trim().startsWith("#"))
		?.trim();
}

export function heuristicProposal(message: string) {
	const lower = message.toLowerCase();
	if (lower.includes("big") || lower.includes("large"))
		return "find . -type f -exec du -h {} + | sort -hr | head -20";
	if (lower.includes("why") && lower.includes("fail"))
		return 'echo "Review the previous command output above."';
	if (lower.includes("git") && lower.includes("status")) return "git status";
	if (lower.startsWith("list") || lower.startsWith("show")) return "ls -la";
	return `echo ${JSON.stringify(message)}`;
}
