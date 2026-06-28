import type { ResolutionTable } from "./resolution";

export type RouteDecision =
	| { kind: "command"; line: string; reason: string }
	| {
			kind: "intent";
			line: string;
			reason: string;
			mode: "oneshot" | "agent" | "auto";
	  }
	| { kind: "passthrough"; line: string; reason: string }
	| { kind: "ambiguous"; line: string; reason: string };

const AGENT_CLIS = new Set([
	"aichat",
	"claude",
	"codex",
	"gemini",
	"opencode",
	"pi",
	"sgpt",
]);
const SHELL_TOKENS = /^(\.|\/|~|\.\/|\.\.|-|--|\||&&|\|\||;|>|<|\$|[\w./-]+=)/;
const ENGLISH = new Set([
	"a",
	"about",
	"again",
	"all",
	"and",
	"are",
	"big",
	"broken",
	"build",
	"can",
	"clean",
	"did",
	"error",
	"explain",
	"fail",
	"failed",
	"files",
	"find",
	"fix",
	"for",
	"get",
	"here",
	"how",
	"in",
	"is",
	"it",
	"large",
	"last",
	"list",
	"make",
	"me",
	"not",
	"now",
	"of",
	"please",
	"show",
	"summarize",
	"tell",
	"that",
	"the",
	"this",
	"to",
	"what",
	"why",
	"without",
	"working",
]);
const AGENT_VERBS = new Set([
	"build",
	"debug",
	"fix",
	"go",
	"implement",
	"investigate",
	"make",
	"repair",
	"set",
	"setup",
	"update",
]);

export function routeLine(
	line: string,
	table: Pick<ResolutionTable, "resolves">,
	childActive = false,
): RouteDecision {
	const trimmed = line.trim();
	if (!trimmed || childActive)
		return {
			kind: "passthrough",
			line,
			reason: childActive ? "child-active" : "empty",
		};

	if (trimmed.startsWith("!!"))
		return {
			kind: "intent",
			line: trimmed.slice(2).trim(),
			reason: "forced-intent",
			mode: "auto",
		};
	if (trimmed.startsWith("::"))
		return {
			kind: "command",
			line: trimmed.slice(2).trim(),
			reason: "forced-command",
		};

	const [first = "", ...rest] = tokenize(trimmed);
	const firstResolved = table.resolves(first);

	if (/^[A-Z]/.test(first) && !firstResolved)
		return {
			kind: "intent",
			line: trimmed,
			reason: "capitalized-unresolved",
			mode: depth(first, rest),
		};
	if (AGENT_CLIS.has(first))
		return { kind: "command", line: trimmed, reason: "agent-cli" };

	const score = scoreTokens(firstResolved ? rest : [first, ...rest]);
	if (firstResolved && parsesLikeCommand(rest, score))
		return { kind: "command", line: trimmed, reason: "resolved-command" };
	if (firstResolved && score.prose > score.command)
		return { kind: "ambiguous", line: trimmed, reason: "resolved-prose" };
	if (score.prose > score.command)
		return {
			kind: "intent",
			line: trimmed,
			reason: "prose-score",
			mode: depth(first, rest),
		};

	return firstResolved
		? { kind: "command", line: trimmed, reason: "resolved-default" }
		: {
				kind: "intent",
				line: trimmed,
				reason: "unresolved-default",
				mode: depth(first, rest),
			};
}

function tokenize(line: string) {
	return line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

function scoreTokens(tokens: string[]) {
	let prose = 0;
	let command = 0;
	for (const raw of tokens) {
		const token = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
		if (!token) continue;
		if (ENGLISH.has(token)) prose++;
		if (
			SHELL_TOKENS.test(raw) ||
			/\.[a-z0-9]+$/i.test(raw) ||
			/^\d+$/.test(raw)
		)
			command++;
	}
	return { prose, command };
}

function parsesLikeCommand(
	rest: string[],
	score: { prose: number; command: number },
) {
	return (
		rest.length === 0 ||
		score.command >= score.prose ||
		rest.some((token) => SHELL_TOKENS.test(token))
	);
}

function depth(first: string, rest: string[]): "oneshot" | "agent" | "auto" {
	const words = [first, ...rest].map((token) => token.toLowerCase());
	if (AGENT_VERBS.has(first.toLowerCase()) && rest.length > 0) return "agent";
	if (
		words.some((word) =>
			[
				"broken",
				"failing",
				"fails",
				"failed",
				"error",
				"errors",
				"working",
			].includes(word),
		)
	)
		return "agent";
	return "auto";
}
