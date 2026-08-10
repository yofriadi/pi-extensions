import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveSelectedSkills } from "../src/skills.ts";
import { assertSelectedSkillCompanionOrdering, injectSelectedSkillMetadata } from "../src/subagent-done.ts";

function makeSkill(root: string, relativeDir: string, name: string, description: string, manual = false): string {
	const dir = join(root, relativeDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "SKILL.md");
	writeFileSync(
		path,
		[
			"---",
			`name: ${name}`,
			`description: ${description}`,
			...(manual ? ["disable-model-invocation: true"] : []),
			"---",
			`FULL BODY ${name}`,
		].join("\n"),
	);
	return path;
}

function env() {
	const cwd = mkdtempSync(join(tmpdir(), "selected-skills-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "selected-skills-agent-"));
	return {
		cwd,
		agentDir,
		cleanup: () => {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

describe("selected skills", () => {
	it("resolves multiple skills in declaration order including manual-only entries", async () => {
		const e = env();
		try {
			makeSkill(e.cwd, ".pi/skills/normal", "normal", "Normal");
			makeSkill(e.cwd, ".pi/skills/manual", "manual", "Manual", true);
			const selected = await resolveSelectedSkills({
				raw: "manual, normal",
				cwd: e.cwd,
				agentDir: e.agentDir,
				projectTrusted: true,
			});
			assert.deepEqual(
				selected.map((skill) => [skill.name, skill.disableModelInvocation]),
				[
					["manual", true],
					["normal", false],
				],
			);
			const prompt = injectSelectedSkillMetadata("base", selected);
			assert.ok(prompt.indexOf("<name>manual</name>") < prompt.indexOf("<name>normal</name>"));
			assert.doesNotMatch(prompt, /FULL BODY/);
			assert.match(readFileSync(selected[0].filePath, "utf8"), /FULL BODY manual/);
		} finally {
			e.cleanup();
		}
	});

	it("keeps unselected skills absent and creates no artifact directories", async () => {
		const e = env();
		try {
			makeSkill(e.cwd, ".pi/skills/selected", "selected", "Selected");
			makeSkill(e.cwd, ".pi/skills/unselected", "unselected", "Unselected");
			const selected = await resolveSelectedSkills({
				raw: "selected",
				cwd: e.cwd,
				agentDir: e.agentDir,
				projectTrusted: true,
			});
			const prompt = injectSelectedSkillMetadata("base", selected);
			assert.match(prompt, /<name>selected<\/name>/);
			assert.doesNotMatch(prompt, /unselected/);
			assert.throws(() => readFileSync(join(e.cwd, ".pi", "subagents", "artifacts"), "utf8"));
		} finally {
			e.cleanup();
		}
	});

	it("rejects unknown, duplicate, empty, and ambiguous effective names before creating resources", async () => {
		const e = env();
		try {
			makeSkill(e.cwd, ".pi/skills/project", "same", "Project");
			makeSkill(e.agentDir, "skills/global", "same", "Global");
			await assert.rejects(
				resolveSelectedSkills({ raw: "missing", cwd: e.cwd, agentDir: e.agentDir, projectTrusted: true }),
				/Unknown subagent skill/,
			);
			await assert.rejects(
				resolveSelectedSkills({ raw: "same", cwd: e.cwd, agentDir: e.agentDir, projectTrusted: true }),
				/Ambiguous subagent skill/,
			);
			await assert.rejects(
				resolveSelectedSkills({ raw: "same, same", cwd: e.cwd, agentDir: e.agentDir, projectTrusted: true }),
				/duplicate/,
			);
			await assert.rejects(
				resolveSelectedSkills({ raw: "same,,other", cwd: e.cwd, agentDir: e.agentDir, projectTrusted: true }),
				/empty/,
			);
			assert.equal(
				existsSync(join(e.cwd, ".pi", "subagents")),
				false,
				"failed validation must create no subagent resources",
			);
		} finally {
			e.cleanup();
		}
	});

	it("ignores project skills when project trust is false", async () => {
		const e = env();
		try {
			makeSkill(e.cwd, ".pi/skills/project-only", "project-only", "Project");
			await assert.rejects(
				resolveSelectedSkills({ raw: "project-only", cwd: e.cwd, agentDir: e.agentDir, projectTrusted: false }),
				/Unknown subagent skill/,
			);
		} finally {
			e.cleanup();
		}
	});
	it("renders all manual-only selections in declaration order", () => {
		const output = injectSelectedSkillMetadata("base", [
			{ name: "first", description: "First", filePath: "/x/first/SKILL.md" },
			{ name: "second", description: "Second", filePath: "/x/second/SKILL.md" },
		]);
		assert.ok(output.indexOf("<name>first</name>") < output.indexOf("<name>second</name>"));
		assert.equal((output.match(/<available_skills>/g) ?? []).length, 1);
	});
	it("creates a standard container when every selected skill is manual-only", () => {
		const output = injectSelectedSkillMetadata("base prompt", [
			{
				name: "manual",
				description: "Manual",
				filePath: "/x/manual/SKILL.md",
			},
		]);
		assert.match(output, /<available_skills>[\s\S]*<name>manual<\/name>[\s\S]*<\/available_skills>/);
		assert.equal((output.match(/<skill>/g) ?? []).length, 1);
		assert.doesNotMatch(output, /FULL BODY/);
	});
	it("fails closed when explicit skills are not before discovered resources", () => {
		assert.doesNotThrow(() => assertSelectedSkillCompanionOrdering(0, undefined));
		assert.doesNotThrow(() => assertSelectedSkillCompanionOrdering(2, "explicit-before-discovered"));
		assert.throws(
			() => assertSelectedSkillCompanionOrdering(1, undefined),
			/Cannot guarantee selected-skill prompt ordering/,
		);
	});
});
