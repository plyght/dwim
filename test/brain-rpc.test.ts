import { expect, test } from "bun:test";
import type { BrainEvent } from "../src/protocol";

test("brain sidecar answers a prompt over the rpc protocol", async () => {
	const proc = Bun.spawn(
		["bun", new URL("../src/brain-rpc.ts", import.meta.url).pathname],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			env: { ...process.env, DWIW_PROVIDER: "", DWIW_MODEL: "" },
		},
	);

	const request = {
		type: "prompt" as const,
		message: "show me big files",
		context: { cwd: "/", history: [], lastOutput: "" },
		mode: "oneshot" as const,
	};
	proc.stdin.write(`${JSON.stringify({ id: 1, request })}\n`);
	proc.stdin.flush();

	const events: BrainEvent[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	collect: for await (const chunk of proc.stdout) {
		buffer += decoder.decode(chunk);
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line.trim()) continue;
			const { event } = JSON.parse(line) as { id: number; event: BrainEvent };
			events.push(event);
			if (event.type === "done") break collect;
		}
	}
	proc.kill();

	const proposal = events.find(
		(event): event is Extract<BrainEvent, { type: "proposal" }> =>
			event.type === "proposal",
	);
	expect(proposal?.command).toContain("find . -type f");
	expect(events.at(-1)?.type).toBe("done");
});
