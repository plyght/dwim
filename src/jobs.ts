export type AgentJob = {
	id: number;
	prompt: string;
	status: "running" | "done" | "error";
	output: string;
};

export class AgentJobs {
	#next = 1;
	#jobs: AgentJob[] = [];

	start(prompt: string) {
		const job: AgentJob = {
			id: this.#next++,
			prompt,
			status: "running",
			output: "",
		};
		this.#jobs.push(job);
		return job;
	}

	append(id: number, output: string) {
		const job = this.get(id);
		if (job) job.output += output;
	}

	finish(id: number, status: "done" | "error" = "done") {
		const job = this.get(id);
		if (job) job.status = status;
	}

	get(id: number) {
		return this.#jobs.find((job) => job.id === id);
	}

	list() {
		return [...this.#jobs];
	}
}
