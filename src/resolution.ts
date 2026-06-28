import { access, readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";

const BUILTINS = new Set([
	"alias",
	"bg",
	"cd",
	"command",
	"dirs",
	"echo",
	"eval",
	"exec",
	"exit",
	"export",
	"fg",
	"history",
	"jobs",
	"popd",
	"pushd",
	"pwd",
	"read",
	"set",
	"source",
	"test",
	"type",
	"ulimit",
	"unalias",
	"unset",
]);

export type ResolutionTable = {
	commands: Set<string>;
	refresh: () => Promise<void>;
	resolves: (token: string) => boolean;
};

export async function createResolutionTable(
	env = Bun.env,
): Promise<ResolutionTable> {
	const commands = new Set(BUILTINS);

	async function refresh() {
		commands.clear();
		for (const builtin of BUILTINS) commands.add(builtin);
		await Promise.all(
			(env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map(async (dir) => {
					try {
						const entries = await readdir(dir);
						await Promise.all(
							entries.map(async (entry) => {
								const path = join(dir, entry);
								try {
									await access(path, 1);
									commands.add(entry);
								} catch {}
							}),
						);
					} catch {}
				}),
		);
	}

	await refresh();

	return {
		commands,
		refresh,
		resolves: (token: string) =>
			commands.has(token) || commands.has(token.toLowerCase()),
	};
}
