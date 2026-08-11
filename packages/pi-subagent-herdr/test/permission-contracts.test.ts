import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";
import { injectSelectedSkillMetadata } from "../src/subagent-done.ts";

const testApi = (subagentsModule as any).__test__;

describe("permission contracts", () => {
	it("builds one canonical active_agent tag", () => {
		assert.equal(testApi.buildActiveAgentTag("scout"), '<active_agent name="scout"/>');
		assert.throws(() => testApi.buildActiveAgentTag("../scout"), /Invalid subagent agent/);
	});

	it("appends the canonical tag and Markdown body exactly once", () => {
		const prompt = testApi.buildSystemPromptFileContent({
			agentName: "worker",
			identity: "You are worker.",
		});
		assert.equal(prompt.flag, "--append-system-prompt");
		assert.equal(prompt.content, '<active_agent name="worker"/>\nYou are worker.');
		assert.equal((prompt.content.match(/<active_agent/g) ?? []).length, 1);
		assert.equal((prompt.content.match(/You are worker\./g) ?? []).length, 1);
	});

	it("hard-denies the parent subagent tool in children", () => {
		assert.deepEqual([...testApi.lifecycleDenySet()], ["subagent"]);
		assert.equal(testApi.lifecycleDenySet().has("subagents_list"), false);
	});

	it("keeps selected metadata in the single section before sanitizer composition", () => {
		const selected = injectSelectedSkillMetadata(
			"<available_skills>\n  <skill>\n    <name>discovered</name>\n    <description>Discovered</description>\n    <location>/project/discovered/SKILL.md</location>\n  </skill>\n</available_skills>",
			[
				{
					name: "manual-selected",
					description: "Selected",
					filePath: "/project/manual/SKILL.md",
				},
			],
		);
		assert.ok(selected.indexOf("manual-selected") < selected.indexOf("</available_skills>"));
		assert.doesNotMatch(selected, /<name>discovered<\/name>/);
		assert.equal((selected.match(/<available_skills>/g) ?? []).length, 1);
	});
});
