import { describe, expect, test } from "bun:test";
import { routeLine } from "../src/router";

const table = {
	resolves: (token: string) =>
		new Set(["ls", "git", "z", "claude", "echo", "cat"]).has(token),
};

describe("routeLine", () => {
	test("passes through empty lines", () => {
		expect(routeLine("", table).kind).toBe("passthrough");
	});

	test("runs resolved commands natively", () => {
		expect(routeLine("ls -la", table)).toMatchObject({
			kind: "command",
			reason: "resolved-command",
		});
		expect(routeLine("git status", table).kind).toBe("command");
	});

	test("routes capitalized prose to intent", () => {
		expect(routeLine("Summarize the big files here", table)).toMatchObject({
			kind: "intent",
		});
	});

	test("routes lowercase prose to intent", () => {
		expect(routeLine("show me big files", table)).toMatchObject({
			kind: "intent",
		});
	});

	test("keeps agent CLIs as commands", () => {
		expect(routeLine("claude fix this", table)).toMatchObject({
			kind: "command",
			reason: "agent-cli",
		});
	});

	test("does not auto-execute resolved prose", () => {
		expect(routeLine("echo why did that fail", table)).toMatchObject({
			kind: "ambiguous",
		});
	});

	test("supports explicit overrides", () => {
		expect(routeLine("!!ls", table)).toMatchObject({
			kind: "intent",
			line: "ls",
		});
		expect(routeLine("::show me", table)).toMatchObject({
			kind: "command",
			line: "show me",
		});
	});
});
