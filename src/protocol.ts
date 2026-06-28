export type ShellContext = {
	cwd: string;
	history: string[];
	lastOutput: string;
	lastExitCode?: number;
	memory?: string[];
	conversation?: { role: "user" | "assistant"; text: string }[];
};

export type BrainRequest = {
	type: "prompt";
	message: string;
	context: ShellContext;
	mode: "oneshot" | "agent" | "auto";
};

export type BrainEvent =
	| { type: "text"; text: string }
	| { type: "proposal"; command: string; explanation?: string }
	| { type: "agent_action"; label: string; detail?: string }
	| { type: "done" }
	| { type: "error"; message: string };
