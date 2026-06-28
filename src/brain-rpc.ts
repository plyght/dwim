import { createBrain } from "./brain";
import type { BrainRequest } from "./protocol";

// Sidecar entry: the brain runs in its own process so pi (and its churn) is
// isolated from the overlay's hot path. Reads `{ id, request }` JSON lines on
// stdin, streams `{ id, event }` JSON lines on stdout. Requests run
// concurrently so a backgrounded agent never blocks a one-shot proposal.
const brain = createBrain({
	provider: Bun.env.DWIW_PROVIDER || undefined,
	model: Bun.env.DWIW_MODEL || undefined,
});

function send(id: number, event: unknown) {
	process.stdout.write(`${JSON.stringify({ id, event })}\n`);
}

for await (const line of console) {
	if (!line.trim()) continue;
	const { id, request } = JSON.parse(line) as {
		id: number;
		request: BrainRequest;
	};
	brain
		.ask(request, (event) => send(id, event))
		.catch((error) => {
			send(id, {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
			send(id, { type: "done" });
		});
}
