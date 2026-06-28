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
			if (request.mode === "agent") {
				emit({
					type: "agent_action",
					label: "thinking",
					detail: request.message,
				});
				const command = await proposeAgentCommand(request, options);
				emit({
					type: "proposal",
					command,
					explanation: "Agent-style command prepared.",
				});
				emit({ type: "done" });
				return;
			}
			const response = await proposeResponse(request, options);
			if (response.kind === "chat") emit({ type: "text", text: response.text });
			else
				emit({
					type: "proposal",
					command: response.command,
					explanation: "Review, edit if needed, then press Enter.",
				});
			emit({ type: "done" });
		},
	};
}

async function proposeAgentCommand(
	request: BrainRequest,
	options: BrainOptions,
) {
	const model = resolveModel(options);
	if (!model) return heuristicAgentProposal(request.message);
	const streamOptions: {
		maxTokens: number;
		apiKey?: string;
		reasoning: "minimal" | "low" | "medium" | "high" | "xhigh";
	} = {
		maxTokens: 500,
		reasoning: "low",
	};
	if (options.provider === "openai-codex") {
		const token = await getCodexToken();
		if (!token) return heuristicAgentProposal(request.message);
		streamOptions.apiKey = token;
	}
	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt:
					"You are dwiw agent mode. The user wants a multi-step shell task, but you must return ONE runnable shell command line for their existing shell. Prefer a compact command that investigates, fixes, and verifies when reasonable. Use &&, subshells, find, git, bun, native tools, or a here-doc if needed. Do not use markdown. Output only the command.",
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: `cwd: ${request.context.cwd}\nmemory: ${(request.context.memory ?? []).join("; ")}\nconversation:\n${formatConversation(request.context.conversation)}\nhistory: ${request.context.history.join("\n")}\nlast output: ${request.context.lastOutput.slice(-6000)}\nrequest: ${request.message}`,
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
		return sanitizeCommand(text) || heuristicAgentProposal(request.message);
	} catch (error) {
		return `echo ${JSON.stringify(`dwiw agent error: ${error instanceof Error ? error.message : String(error)}`)}`;
	}
}

async function proposeResponse(request: BrainRequest, options: BrainOptions) {
	const model = resolveModel(options);
	if (!model)
		return {
			kind: "command" as const,
			command: heuristicProposal(request.message),
		};
	const streamOptions: {
		maxTokens: number;
		apiKey?: string;
		reasoning: "minimal" | "low" | "medium" | "high" | "xhigh";
	} = {
		maxTokens: 300,
		reasoning: "minimal",
	};
	if (options.provider === "openai-codex") {
		let token: string | null = null;
		try {
			token = await getCodexToken();
		} catch (error) {
			return {
				kind: "chat" as const,
				text: `dwiw: auth error — try 'dwiw login' again (${error instanceof Error ? error.message : String(error)})`,
			};
		}
		if (!token)
			return {
				kind: "chat" as const,
				text: "dwiw: not signed in — run 'dwiw login' (falling back offline).",
			};
		streamOptions.apiKey = token;
	}
	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt:
					"You are dwiw, a fast natural shell brain. The router has already decided this is natural language, not a native shell command. Decide the best response type. If the user wants conversation, explanation, or advice, respond with exactly: CHAT: <short natural reply>. If the user wants the computer to do or check something through the shell, respond with exactly: COMMAND: <one runnable shell command>. Bias toward COMMAND whenever the user asks you to do, run, check, find, fetch, or look something up — do not ask for confirmation, just produce the command. Use the conversation so far to resolve follow-ups like 'yes do it' or 'yes check' into the concrete COMMAND that was being discussed. It has internet and standard tools; assume named tools are installed. Prefer Bun for JS/TS. No markdown, no backticks, no extra labels.",
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: `cwd: ${request.context.cwd}\nmemory: ${(request.context.memory ?? []).join("; ")}\nconversation:\n${formatConversation(request.context.conversation)}\nhistory: ${request.context.history.join("\n")}\nlast output: ${request.context.lastOutput.slice(-4000)}\nrequest: ${request.message}`,
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
		const parsed = parseBrainResponse(text);
		if (parsed) return parsed;
		const command = sanitizeCommand(text);
		return command
			? { kind: "command" as const, command }
			: {
					kind: "command" as const,
					command: heuristicProposal(request.message),
				};
	} catch (error) {
		return {
			kind: "command" as const,
			command: `echo ${JSON.stringify(`dwiw brain error: ${error instanceof Error ? error.message : String(error)}`)}`,
		};
	}
}

function formatConversation(
	conversation: BrainRequest["context"]["conversation"],
) {
	if (!conversation || conversation.length === 0) return "(none)";
	return conversation
		.map((turn) => `${turn.role === "user" ? "user" : "dwiw"}: ${turn.text}`)
		.join("\n");
}

function resolveModel(options: BrainOptions) {
	if (typeof options.model !== "string") return options.model;
	if (!options.model || !options.provider) return undefined;
	return getModel(
		options.provider as never,
		options.model as never,
	) as Model<Api>;
}

function parseBrainResponse(text: string) {
	const chat = text.match(/^CHAT:\s*([\s\S]*)$/i);
	if (chat?.[1]?.trim()) return { kind: "chat" as const, text: chat[1].trim() };
	const command = text.match(/^COMMAND:\s*([\s\S]*)$/i);
	if (command?.[1]?.trim()) {
		const sanitized = sanitizeCommand(command[1]);
		if (sanitized) return { kind: "command" as const, command: sanitized };
	}
	return undefined;
}

function sanitizeCommand(text: string) {
	return text
		.replace(/^```(?:sh|bash|shell)?/i, "")
		.replace(/```$/i, "")
		.split("\n")
		.find((line) => line.trim() && !line.trim().startsWith("#"))
		?.trim();
}

export function heuristicAgentProposal(message: string) {
	const lower = message.toLowerCase();
	if (lower.includes("test") || lower.includes("fail")) return "bun run check";
	if (lower.includes("git")) return "git status && git diff --stat";
	if (lower.includes("broken") || lower.includes("working"))
		return "bun run check";
	return heuristicProposal(message);
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
