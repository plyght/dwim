#!/usr/bin/env bun
const command = Bun.argv[2];

if (command === "login") {
	const { runLogin } = await import("./auth");
	await runLogin();
	process.exit(process.exitCode ?? 0);
}
if (command === "logout") {
	const { runLogout } = await import("./auth");
	await runLogout();
	process.exit(0);
}
if (
	command === "route" ||
	command === "ask" ||
	command === "jobs" ||
	command === "fg"
) {
	await runClient(command);
	process.exit(0);
}
if (command === "--help" || command === "-h") {
	console.log(
		[
			"dwiw — talk to your shell",
			"  dwiw          start the shell overlay",
			"  dwiw login    sign in to OpenAI Codex (OAuth)",
			"  dwiw logout   remove saved Codex credentials",
			"  dwiw jobs     list background agent jobs",
			"  dwiw fg <id>  show a background agent job",
			"  inside the shell: !!text forces intent, ::command forces a command",
		].join("\n"),
	);
	process.exit(0);
}

const { runOverlay } = await import("./overlay");
await runOverlay();

async function runClient(op: "route" | "ask" | "jobs" | "fg") {
	const sock = Bun.env.DWIW_SOCK;
	const args = Bun.argv.slice(3);
	const dashes = args.indexOf("--");
	const line = dashes >= 0 ? args.slice(dashes + 1).join(" ") : "";
	const cwdFlag = args.indexOf("--cwd");
	const cwd =
		cwdFlag >= 0 ? (args[cwdFlag + 1] ?? process.cwd()) : process.cwd();

	if (!sock) {
		// Fail safe: without a daemon, never break the shell — just run the line.
		if (op === "route") process.stdout.write(`command\n${line}`);
		process.exit(0);
	}

	const { ipcRequest } = await import("./ipc");
	try {
		if (op === "route") {
			let reply = { kind: "command", line };
			await ipcRequest(sock, { op: "route", line }, (message) => {
				if ("kind" in message) reply = message;
			});
			process.stdout.write(`${reply.kind}\n${reply.line}`);
			return;
		}
		if (op === "ask") {
			let action = "chat";
			let cmd = "";
			await ipcRequest(sock, { op: "ask", line, cwd }, (message) => {
				if ("out" in message) process.stderr.write(message.out);
				if ("result" in message) {
					action = message.result.action;
					cmd = message.result.command ?? "";
				}
			});
			if (action === "run") process.stdout.write(`RUN\n${cmd}`);
			else if (action === "edit") process.stdout.write(`EDIT\n${cmd}`);
			return;
		}
		if (op === "jobs") {
			await ipcRequest(sock, { op: "jobs" }, (message) => {
				if ("jobs" in message)
					for (const job of message.jobs)
						process.stdout.write(`[${job.id}] ${job.status} ${job.prompt}\n`);
			});
			return;
		}
		if (op === "fg") {
			const id = Number(args.find((arg) => /^\d+$/.test(arg)) ?? "0");
			await ipcRequest(sock, { op: "fg", id }, (message) => {
				if ("output" in message) {
					process.stdout.write(`${message.output}\n`);
					if (message.proposal) process.stdout.write(`\n${message.proposal}\n`);
				}
			});
			return;
		}
	} catch {
		if (op === "route") process.stdout.write(`command\n${line}`);
	}
}
