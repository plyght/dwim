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
if (command === "--help" || command === "-h") {
	console.log(
		[
			"dwim — talk to your shell",
			"  dwim          start the shell overlay",
			"  dwim login    sign in to OpenAI Codex (OAuth)",
			"  dwim logout   remove saved Codex credentials",
			"  inside the shell: !!text forces intent, ::command forces a command",
		].join("\n"),
	);
	process.exit(0);
}

const { runOverlay } = await import("./overlay");
await runOverlay();
