import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";

const testApi = (subagentsModule as any).__test__;

describe("body-only identity prompt", () => {
	it("always appends one canonical tag followed by one Markdown body", () => {
		const result = testApi.buildSystemPromptFileContent({
			agentName: "reviewer",
			identity: "You are a specialized reviewer.",
		});
		assert.equal(result.flag, "--append-system-prompt");
		assert.equal(result.content, '<active_agent name="reviewer"/>\nYou are a specialized reviewer.');
		assert.equal((result.content.match(/<active_agent/g) ?? []).length, 1);
		assert.equal((result.content.match(/specialized reviewer/g) ?? []).length, 1);
	});

	it("rejects every obsolete system-prompt mode instead of routing it", () => {
		for (const mode of ["append", "replace", "foobar"]) {
			assert.throws(
				() =>
					testApi.parseAgentDefinition(
						`---\nname: reviewer\nsystem-prompt: ${mode}\n---\nBody\n`,
						"reviewer",
						"/tmp/reviewer.md",
					),
				/obsolete system-prompt/,
			);
		}
	});
});
