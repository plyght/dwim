import { expect, test } from "bun:test";
import { needsConfirm } from "../src/config";

const config = {
	proposalUx: "inline" as const,
	autoRun: false,
	destructiveGuard: true,
	confirmAll: false,
	provider: "",
	model: "",
	plugins: [],
};

test("destructive guard catches dangerous commands only when enabled", () => {
	expect(needsConfirm("rm -rf /tmp/x", config)).toBe(true);
	expect(needsConfirm("ls -la", config)).toBe(false);
	expect(
		needsConfirm("rm -rf /tmp/x", { ...config, destructiveGuard: false }),
	).toBe(false);
});
