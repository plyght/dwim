import type { Socket } from "bun";

export type IpcRequest =
	| { op: "route"; line: string }
	| { op: "ask"; line: string; cwd: string }
	| { op: "jobs" }
	| { op: "fg"; id: number };

export type RouteReply = {
	kind: "command" | "intent" | "ambiguous" | "passthrough";
	line: string;
};

export type AskAction = "run" | "edit" | "chat";

export type IpcMessage =
	| RouteReply
	| { out: string }
	| { result: { action: AskAction; command?: string } }
	| { jobs: { id: number; status: string; prompt: string }[] }
	| { output: string; proposal?: string };

export type IpcConn = {
	send: (message: IpcMessage) => void;
	close: () => void;
};

// A newline-delimited JSON socket. The overlay process owns the router, brain,
// and job state; the in-shell `dwiw route`/`dwiw ask` clients connect here so
// the shell itself stays the source of truth for the prompt.
export function serveIpc(
	path: string,
	handle: (request: IpcRequest, conn: IpcConn) => void,
) {
	const buffers = new WeakMap<Socket, { buf: string }>();
	return Bun.listen<undefined>({
		unix: path,
		socket: {
			open(socket) {
				buffers.set(socket, { buf: "" });
			},
			data(socket, chunk) {
				const state = buffers.get(socket);
				if (!state) return;
				state.buf += chunk.toString();
				let newline = state.buf.indexOf("\n");
				while (newline >= 0) {
					const line = state.buf.slice(0, newline);
					state.buf = state.buf.slice(newline + 1);
					newline = state.buf.indexOf("\n");
					if (!line) continue;
					const request = JSON.parse(line) as IpcRequest;
					handle(request, {
						send: (message) => socket.write(`${JSON.stringify(message)}\n`),
						close: () => socket.end(),
					});
				}
			},
		},
	});
}

export async function ipcRequest(
	path: string,
	request: IpcRequest,
	onMessage: (message: IpcMessage) => void,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let buf = "";
		Bun.connect<undefined>({
			unix: path,
			socket: {
				open(socket) {
					socket.write(`${JSON.stringify(request)}\n`);
				},
				data(_socket, chunk) {
					buf += chunk.toString();
					let newline = buf.indexOf("\n");
					while (newline >= 0) {
						const line = buf.slice(0, newline);
						buf = buf.slice(newline + 1);
						newline = buf.indexOf("\n");
						if (line) onMessage(JSON.parse(line) as IpcMessage);
					}
				},
				close() {
					resolve();
				},
				error(_socket, error) {
					reject(error);
				},
			},
		}).catch(reject);
	});
}
