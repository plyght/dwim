import { expect, test } from "bun:test";
import { heuristicProposal } from "../src/brain";

test("proposes a native command for big-file requests", () => {
	expect(heuristicProposal("show me big files")).toContain("find . -type f");
});
