import { expect, test } from "bun:test";
import { AgentJobs } from "../src/jobs";

test("tracks background agent jobs", () => {
	const jobs = new AgentJobs();
	const job = jobs.start("fix it");
	jobs.append(job.id, "done");
	jobs.finish(job.id);
	expect(jobs.list()).toEqual([
		{ id: 1, prompt: "fix it", status: "done", output: "done" },
	]);
});
