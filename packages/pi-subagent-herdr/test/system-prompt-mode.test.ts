import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";

const testApi = (subagentsModule as any).__test__;

describe("body-only identity prompt", () => {
	// Regression: with --append-system-prompt the child had no explicit prompt
	// source, so pi's resource loader fell back to discovering the parent's
	// ~/.pi/agent/SYSTEM.md and the child inherited the parent's tool surface.
	// An explicit --system-prompt short-circuits that discovery; the launch also
	// claims the append slot so APPEND_SYSTEM.md is not discovered either.
	// Argv-level proof lives in subagent-launch.test.ts; this pins the contract.
	it("states one canonical tag and one Markdown body as the whole prompt", () => {
		const result = testApi.buildSystemPromptFileContent({
			agentName: "reviewer",
			identity: "You are a specialized reviewer.",
		});
		assert.equal(result.flag, "--system-prompt");
		assert.equal(result.content, '<active_agent name="reviewer"/>\nYou are a specialized reviewer.');
		assert.equal((result.content.match(/<active_agent/g) ?? []).length, 1);
		assert.equal((result.content.match(/specialized reviewer/g) ?? []).length, 1);
	});

	it("carries the identity tag even when the body is empty", () => {
		const result = testApi.buildSystemPromptFileContent({ agentName: "reviewer", identity: "" });
		assert.equal(result.flag, "--system-prompt");
		assert.equal(result.content, '<active_agent name="reviewer"/>');
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
