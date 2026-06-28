import { createBrain } from "./brain";
import type { BrainRequest } from "./protocol";

const brain = createBrain();

for await (const line of console) {
	const request = JSON.parse(line) as BrainRequest;
	await brain.ask(request, (event) => console.log(JSON.stringify(event)));
}
