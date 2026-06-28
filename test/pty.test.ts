import { expect, test } from "bun:test";
import { closeSync } from "node:fs";
import { openPty } from "../src/pty";

test("openPty allocates a real pty pair via FFI", () => {
	const { master, slave } = openPty(24, 80);
	expect(master).toBeGreaterThan(2);
	expect(slave).toBeGreaterThan(2);
	closeSync(master);
	closeSync(slave);
});
