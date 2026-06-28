import type { BrainEvent, BrainRequest } from "./protocol";

export type Brain = {
	ask: (
		request: BrainRequest,
		emit: (event: BrainEvent) => void,
	) => Promise<void>;
	close: () => void;
};

export type BrainClientOptions = { provider?: string; model?: string };

// Spawns the brain sidecar once and multiplexes requests over stdio by id, so
// concurrent agent jobs and one-shot proposals share a single long-lived
// process (no per-request startup cost).
export function createBrainClient(options: BrainClientOptions = {}): Brain {
	const child = Bun.spawn(
		["bun", new URL("./brain-rpc.ts", import.meta.url).pathname],
		{
			env: {
				...process.env,
				DWIW_PROVIDER: options.provider ?? "",
				DWIW_MODEL: options.model ?? "",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		},
	);

	const pending = new Map<
		number,
		{ emit: (event: BrainEvent) => void; resolve: () => void }
	>();
	let nextId = 1;

	(async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk);
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line.trim()) route(line);
			}
		}
		for (const handler of pending.values()) {
			handler.emit({
				type: "error",
				message: "brain sidecar closed before responding",
			});
			handler.resolve();
		}
		pending.clear();
	})();

	function route(line: string) {
		const { id, event } = JSON.parse(line) as { id: number; event: BrainEvent };
		const handler = pending.get(id);
		if (!handler) return;
		handler.emit(event);
		if (event.type === "done") {
			pending.delete(id);
			handler.resolve();
		}
	}

	return {
		ask(request, emit) {
			const id = nextId++;
			return new Promise<void>((resolve) => {
				pending.set(id, { emit, resolve });
				child.stdin.write(`${JSON.stringify({ id, request })}\n`);
				child.stdin.flush();
			});
		},
		close() {
			child.kill();
		},
	};
}
