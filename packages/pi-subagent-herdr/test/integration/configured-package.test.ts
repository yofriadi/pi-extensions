/**
 * Production-like configured-package regression for extension-free
 * selected-skill resolution.
 *
 * A purpose-built fixture package ships BOTH:
 *   (a) an ordinary skill file the test agent selects (enumerable evidence —
 *       an extension-only package produces nothing in getSkills()), and
 *   (b) an extension whose factory writes a marker file if it is ever
 *       executed.
 *
 * The fixture is wired into the parent through a project `.pi/settings.json`
 * `packages` entry — the production package mechanism — so the resolver's
 * `DefaultResourceLoader` discovers it. Herdr itself stays on the harness's
 * explicit `-e` path (a marker side effect cannot be added to it).
 *
 * The in-process assertions prove non-vacuity WITHOUT executing the fixture
 * (extension-free discovery forbids factory evaluation): the fixture skill
 * must appear in the resolver's enumerated skills AND the marker file must
 * NOT exist. The spawned parent/child run then supplies the end-to-end
 * one-`subagent_result` assertion: selecting the fixture skill must not poison
 * the parent's active completion runtime, so the async child result is
 * delivered exactly once.
 *
 * Run `PI_TEST_MODEL="tokenrouter/gpt-5.6-luna" npm run test:integration`
 * from inside herdr. The spawned half requires herdr + a live model; the
 * in-process half runs anywhere.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	cleanupTestEnv,
	countSubagentResultSteers,
	createTestEnv,
	createTrackedSurface,
	findSubagentLaunchRunId,
	getAvailableBackends,
	PI_TIMEOUT,
	sleep,
	startPi,
	type TestEnv,
	trackTempFile,
	uniqueId,
	waitForFile,
} from "./harness.ts";

const backends = getAvailableBackends();

/** Write the fixture package + project settings into a project directory.
 * Returns the paths the assertions need. The package source recorded in
 * `.pi/settings.json` is RELATIVE to the project's `.pi/` directory (the
 * project-scope base dir), matching how a committed project package entry
 * would be written. */
function writeFixturePackage(projectDir: string): { packageDir: string; markerFile: string; skillName: string } {
	const packageDir = join(projectDir, "fixture-package");
	const skillName = "fixture-package-skill";
	const markerFile = join(projectDir, ".pi", "fixture-extension-factory-ran.marker");

	mkdirSync(join(packageDir, "skills", skillName), { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify(
			{
				name: "herdr-test-fixture-package",
				version: "0.0.1",
				pi: { extensions: ["./marker-extension.ts"], skills: ["./skills"] },
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(packageDir, "marker-extension.ts"),
		[
			"// Append one line per execution so a SECOND factory run (e.g. from the",
			"// selected-skill resolver) is distinguishable from the parent startup load.",
			'import { appendFileSync } from "node:fs";',
			`const MARKER = ${JSON.stringify(markerFile)};`,
			"export default function markerExtension() {",
			'  appendFileSync(MARKER, "run\\n");',
			"}",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(packageDir, "skills", skillName, "SKILL.md"),
		[
			"---",
			`name: ${skillName}`,
			"description: Fixture package skill for extension-free resolution",
			"---",
			"FIXTURE_PACKAGE_SKILL_BODY: read this file, then run the exact task command.",
			"",
		].join("\n"),
	);

	// Relative from <project>/.pi — the project-scope package base directory.
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(
		join(projectDir, ".pi", "settings.json"),
		JSON.stringify({ packages: ["../fixture-package"] }, null, 2),
	);
	return { packageDir, markerFile, skillName };
}

function countFactoryExecutions(markerFile: string): number {
	return existsSync(markerFile) ? readFileSync(markerFile, "utf8").split("\n").filter(Boolean).length : 0;
}

async function waitForStableFactoryExecutions(markerFile: string, timeout = PI_TIMEOUT): Promise<number> {
	const deadline = Date.now() + timeout;
	let previous = 0;
	let stableSince = 0;
	while (Date.now() < deadline) {
		const current = countFactoryExecutions(markerFile);
		if (current > 0) {
			if (current !== previous) {
				previous = current;
				stableSince = Date.now();
			} else if (Date.now() - stableSince >= 1000) {
				return current;
			}
		}
		await sleep(100);
	}
	throw new Error(`fixture factory did not settle within ${timeout}ms (got ${previous})`);
}

/** The resolver's exact loader shape (mirrors src/skills.ts). */
async function enumerateSkills(projectDir: string, agentDir: string) {
	const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	return loader.getSkills();
}

describe("configured-package fixture: extension-free resolution (in-process)", () => {
	it("enumerates the fixture skill without executing the fixture extension factory", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "fixture-package-proj-"));
		const agentDir = mkdtempSync(join(tmpdir(), "fixture-package-agent-"));
		try {
			const { markerFile, skillName } = writeFixturePackage(projectDir);

			// Non-vacuity, positive: the package's ordinary skill IS discovered
			// through the project settings.json package entry.
			const { skills, diagnostics } = await enumerateSkills(projectDir, agentDir);
			assert.ok(
				skills.some((skill) => skill.name === skillName),
				`fixture skill must be enumerated (got: ${skills.map((s) => s.name).join(", ") || "none"})`,
			);
			assert.equal(
				diagnostics.filter((d: any) => d.type === "collision" && d.collision?.name === skillName).length,
				0,
				"fixture skill must not be flagged ambiguous",
			);

			// Non-vacuity, negative: extension-free discovery executed NO factory.
			assert.equal(existsSync(markerFile), false, "fixture extension factory must never run during discovery");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

if (backends.length === 0) {
	console.log("⚠️  herdr is unavailable — skipping configured-package spawned integration test");
}

// Spawned half runs whenever a live Herdr backend is available. It is part of
// the normal integration command so the production topology cannot silently
// regress behind an undocumented opt-in.
const describeSpawned = backends.length > 0 ? describe : describe.skip;

describeSpawned("configured-package fixture: async completion delivery (spawned)", () => {
	let env: TestEnv;

	before(() => {
		env = createTestEnv(backends[0]!);
	});

	after(() => {
		if (env) cleanupTestEnv(env);
	});

	it(
		"delivers exactly one subagent_result for an async child whose agent selects the fixture skill",
		{ timeout: PI_TIMEOUT * 3 },
		async () => {
			const id = uniqueId();
			const { markerFile, skillName } = writeFixturePackage(env.dir);

			// The test agent declares the fixture package's skill. `caller_ping: deny`
			// keeps the run on the plain completion path.
			writeFileSync(
				join(env.dir, ".pi", "agents", "test-package-skill.md"),
				[
					"---",
					"name: test-package-skill",
					"tools: read, bash",
					`skills: ${skillName}`,
					"seed: fresh",
					"permission:",
					"  caller_ping: deny",
					"---",
					`You are a package-skill integration agent. Read the explicitly selected ${skillName} SKILL.md, then immediately run the exact bash command in the task. Use no other tools, do not inspect the environment, and never use unselected skills.`,
					"",
				].join("\n"),
			);

			const childMarker = `/tmp/pi-integ-package-skill-${id}.txt`;
			trackTempFile(env, childMarker);
			const sessionFile = join(env.dir, `parent-${id}.jsonl`);
			trackTempFile(env, sessionFile);
			const surface = createTrackedSurface(env, `package-skill-${id}`);
			await sleep(1000);

			const task = [
				`Call the subagent tool with these EXACT parameters (async, do NOT pass blocking):`,
				`  label: "Pkg-${id}"`,
				`  agent: "test-package-skill"`,
				`  task: "Run exactly: echo 'PACKAGE_SKILL_${id}' > '${childMarker}'"`,
				`After the subagent_result arrives, say PACKAGE_SKILL_DONE_${id}.`,
			].join("\n");
			const isolatedAgentDir = join(env.dir, ".pi", "isolated-agent");
			startPi(surface, env.dir, task, {
				sessionFile,
				noExtensions: false,
				env: { PI_CODING_AGENT_DIR: isolatedAgentDir, PI_SUBAGENT_NO_EXTENSIONS: "1" },
			});
			const startupFactoryExecutions = await waitForStableFactoryExecutions(markerFile);

			// Wait for the child to finish its work first (existing tests use the
			// child marker as the hard signal), then capture the exact run ID returned
			// by the parent tool call rather than counting unrelated results.
			const content = await waitForFile(childMarker, PI_TIMEOUT, /PACKAGE_SKILL_/);
			assert.match(content, new RegExp(`PACKAGE_SKILL_${id}`));
			const expectedName = `Pkg-${id}`;
			let expectedRunId: string | undefined;
			{
				const deadline = Date.now() + 10_000;
				while (!(expectedRunId = findSubagentLaunchRunId(sessionFile, expectedName)) && Date.now() < deadline) {
					await sleep(250);
				}
			}
			assert.match(expectedRunId ?? "", /^[a-f0-9]{32}$/, "captured the launched child's exact run ID");

			// Poll for the matching result, then hold a duplicate-detection window
			// beyond the primary 8s acknowledgement grace plus the first retry tick.
			{
				const deadline = Date.now() + 30_000;
				while (countSubagentResultSteers(sessionFile, expectedRunId) < 1 && Date.now() < deadline) {
					await sleep(500);
				}
			}
			await sleep(12_000);
			assert.equal(
				countSubagentResultSteers(sessionFile, expectedRunId),
				1,
				"the launched run must deliver exactly one matching subagent_result",
			);
			assert.equal(
				countSubagentResultSteers(sessionFile),
				1,
				"the isolated parent session must contain no unrelated/duplicate subagent_result",
			);

			// This parent intentionally omits `-ne` so its project settings package is
			// loaded. The child receives `PI_SUBAGENT_NO_EXTENSIONS=1`, so the fixture
			// factory must not execute again after the parent startup count settles.
			const markerExecutions = countFactoryExecutions(markerFile);
			assert.equal(
				markerExecutions,
				startupFactoryExecutions,
				`fixture extension factory executed after startup (startup=${startupFactoryExecutions}, final=${markerExecutions})`,
			);
		},
	);
});
