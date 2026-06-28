#!/usr/bin/env bun
if (Bun.argv.includes("--help")) {
	console.log(
		"dwim: shell overlay. Use !!text to force intent, ::command to force command.",
	);
	process.exit(0);
}

const { runOverlay } = await import("./overlay");
await runOverlay();
