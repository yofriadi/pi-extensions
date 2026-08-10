import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { parseAgentDefinition } from "../src/agent-definition.ts";
import { buildSystemPromptFileContent } from "../src/index.ts";

describe("permission-system composition contracts", () => {
	it("preserves permission frontmatter and exact agent-root identity inputs", () => {
		const dir = mkdtempSync(join(tmpdir(), "permission-contract-"));
		try {
			const agent = parseAgentDefinition(
				["---", "name: reviewer", "tools: read", "permission:", "  read: allow", "---", "Body"].join("\n"),
				"reviewer",
				join(dir, "reviewer.md"),
			);
			assert.match(agent.frontmatter, /permission:\n {2}read: allow/);
			const prompt = buildSystemPromptFileContent({ agentName: agent.id, identity: agent.body });
			assert.match(prompt.content, /<active_agent name="reviewer"\/>/);
			assert.match(prompt.content, /Body/);
			assert.equal(prompt.content.includes("system-prompt"), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps selected skill paths as metadata inputs rather than bodies", () => {
		const dir = mkdtempSync(join(tmpdir(), "permission-skill-"));
		try {
			const skill = join(dir, "SKILL.md");
			writeFileSync(skill, "---\nname: private\ndescription: Private\n---\nSECRET BODY");
			const metadata = JSON.stringify([{ name: "private", description: "Private", filePath: skill }]);
			assert.equal(metadata.includes("SECRET BODY"), false);
			assert.equal(readFileSync(skill, "utf8").includes("SECRET BODY"), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs injected metadata through the installed permission sanitizer", async (t) => {
		const installed = join(
			process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
			"npm",
			"node_modules",
			"@gotgenes",
			"pi-permission-system",
			"src",
			"skill-prompt-sanitizer.ts",
		);
		if (!existsSync(installed)) {
			t.skip("permission system not installed");
			return;
		}
		const dir = mkdtempSync(join(tmpdir(), "permission-sanitizer-"));
		try {
			const copied = join(dir, "skill-prompt-sanitizer.ts");
			writeFileSync(copied, readFileSync(installed, "utf8"));
			const { resolveSkillPromptEntries } = await import(pathToFileURL(copied).href);
			const prompt = [
				"<available_skills>",
				"<skill><name>denied</name><description>D</description><location>/x/d/SKILL.md</location></skill>",
				"<skill><name>asked</name><description>A</description><location>/x/a/SKILL.md</location></skill>",
				"<skill><name>allowed</name><description>L</description><location>/x/l/SKILL.md</location></skill>",
				"</available_skills>",
			].join("\n");
			const result = resolveSkillPromptEntries(
				prompt,
				{
					checkPermission(_surface: string, input: any) {
						return { state: input.name === "denied" ? "deny" : input.name === "asked" ? "ask" : "allow" };
					},
				},
				"reviewer",
				{
					comparableValue(value: string) {
						return value;
					},
					isWithinDirectory(value: string, base: string) {
						return value.startsWith(`${base}/`);
					},
				},
			);
			assert.doesNotMatch(result.prompt, /<name>denied<\/name>/);
			assert.match(result.prompt, /<name>asked<\/name>/);
			assert.match(result.prompt, /<name>allowed<\/name>/);
			assert.deepEqual(
				result.entries.map((entry: any) => [entry.name, entry.state]),
				[
					["asked", "ask"],
					["allowed", "allow"],
				],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
