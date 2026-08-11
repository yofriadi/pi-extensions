/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn real pi sessions with real LLM calls.
 * Each test creates a herdr pane, runs pi with a task that uses the subagent
 * tool, and verifies the outcome through marker files and terminal output.
 *
 * Duration: ~30-120s per test, depending on the selected model.
 *
 * Run `PI_TEST_MODEL="deepseek-v4-flash-free" PI_TEST_TIMEOUT=180000
 * npm run test:integration` from inside herdr. The explicit model keeps
 * real-LLM runs predictable and the longer timeout covers the lifecycle suite.
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions (default: deepseek-v4-flash-free)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	cleanupTestEnv,
	createTestEnv,
	createTrackedSurface,
	getAvailableBackends,
	herdrPaneExists,
	interruptPane,
	PERMISSION_EXTENSION,
	PI_TIMEOUT,
	readPane,
	restoreBackend,
	setBackend,
	sleep,
	startPi,
	type TestEnv,
	trackTempFile,
	uniqueId,
	waitForChildPaneCount,
	waitForFile,
	waitForInspection,
	waitForScreen,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
	console.log("⚠️  herdr is unavailable — skipping subagent lifecycle integration tests");
	console.log("   Run inside herdr to enable these tests.");
}

for (const backend of backends) {
	describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 8, concurrency: 1 }, () => {
		let prevMux: string | undefined;
		let env: TestEnv;

		before(() => {
			prevMux = setBackend(backend);
			env = createTestEnv(backend);
		});

		after(() => {
			cleanupTestEnv(env);
			restoreBackend(prevMux);
		});

		// ── Basic spawn + completion ──

		it("spawns a subagent that writes a file and verifies the session", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `echo-${id}`);
			await sleep(1000);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "Echo-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
				`After you receive the subagent result, say INTEGRATION_COMPLETE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// Verify: subagent created the marker file
			const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
			assert.ok(content.includes(`PASS_${id}`), `Marker file should contain PASS_${id}. Got: ${content.trim()}`);

			// Verify: outer pi received the subagent result
			const screen = await waitForScreen(surface, /INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i, PI_TIMEOUT);

			// Verify: session file was created (shown in steer result)
			const sessionMatch = screen.match(/Session log:\s*(\S+\.jsonl)/);
			if (sessionMatch) {
				const sessionFile = sessionMatch[1];
				assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);

				const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
				assert.ok(lines.length >= 2, `Session should have ≥2 entries, got ${lines.length}`);

				const header = JSON.parse(lines[0]);
				assert.equal(header.type, "session", "First entry should be session header");
				assert.ok(header.id, "Session header should have an id");
			}
		});

		// ── In-progress activity snapshots ──

		it("keeps a long active tool call from surfacing false stalled status", async () => {
			const id = uniqueId();
			const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
			const markerFile = `/tmp/pi-integ-status-${id}.txt`;
			trackTempFile(env, startFile);
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `status-${id}`);
			await sleep(1000);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "Status-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
				`After you receive the subagent result, say STATUS_TEST_DONE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
			assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

			await waitForFile(startFile, PI_TIMEOUT, /START_/);
			assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
			await sleep(65_000);
			assert.equal(
				existsSync(markerFile),
				false,
				"Completion marker should not exist before the watchdog assertion",
			);
			const watchdogScreen = readPane(surface, 300);
			assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

			const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
			assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

			const completionScreen = await waitForScreen(
				surface,
				/STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
				PI_TIMEOUT,
				300,
			);
			assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
		});

		it("projects child-pane Escape as interrupted while preserving the child pane", async () => {
			const id = uniqueId();
			const startFile = `/tmp/pi-integ-child-interrupt-start-${id}.txt`;
			trackTempFile(env, startFile);
			const surface = createTrackedSurface(env, `child-interrupt-${id}`);
			await sleep(1_000);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "ChildInterrupt-${id}"`,
				`  agent: "test-echo"`,
				`  blocking: true`,
				`  task: "Run this bash command: echo 'CHILD_INTERRUPT_START_${id}' > '${startFile}'; sleep 90"`,
				`Do not do anything else before calling subagent; wait for its tool result.`,
			].join("\n");
			const { identity } = startPi(surface, env.dir, task);
			await waitForFile(startFile, PI_TIMEOUT, /CHILD_INTERRUPT_START_/);

			const layout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			const child = layout.panes.find((pane) => pane.paneId !== identity.paneId);
			assert.ok(child, "expected a visible child pane before sending Escape");
			interruptPane(child.paneId);

			await waitForScreen(
				surface,
				/ChildInterrupt-.*interrupted|interrupted.*ChildInterrupt-/is,
				PI_TIMEOUT,
				300,
			);
			assert.equal(herdrPaneExists(child.paneId), true, "child pane remains available for direct user recovery");
		});

		// ── Parallel subagent spawn ──

		it("spawns two subagents in parallel and both complete", async () => {
			const id = uniqueId();
			const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
			const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
			trackTempFile(env, fileA);
			trackTempFile(env, fileB);

			const surface = createTrackedSurface(env, `parallel-${id}`);
			await sleep(1000);

			const task = [
				`You must call the subagent tool TWICE. Make both calls before waiting for results.`,
				``,
				`First call:`,
				`  label: "ParaA-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
				``,
				`Second call:`,
				`  label: "ParaB-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
				``,
				`Call both subagent tools NOW, do not wait between them.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// Both marker files should appear
			const [contentA, contentB] = await Promise.all([
				waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
				waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
			]);

			assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
			assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
		});

		// ── Fork mode ──

		it("fork mode creates a child session linked to the parent", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `fork-${id}`);
			await sleep(1000);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "Fork-${id}"`,
				`  agent: "test-fork"`,
				`  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
				`After you receive the result, say FORK_COMPLETE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// Verify: forked subagent created the file
			const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
			assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);

			// Wait for the outer pi to show the result
			const screen = await waitForScreen(surface, /FORK_COMPLETE|completed|Sub-agent.*"Fork/i, PI_TIMEOUT);

			// Receiving the result proves the agent-owned fork seed auto-exited and finalized.

			// Verify: the forked session has a parent link
			const sessionMatch = screen.match(/Session log:\s*(\S+\.jsonl)/);
			if (sessionMatch) {
				const sessionFile = sessionMatch[1];
				assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

				const entries = readFileSync(sessionFile, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l));
				const header = entries[0];
				assert.equal(header.type, "session", "First entry should be session header");
				assert.ok(header.parentSession, "Fork session should have parentSession field");
				// Fork sessions include parent context (model_change entries etc.)
				assert.ok(entries.length >= 2, "Fork session should have context entries beyond header");
			}
		});

		// ── Agent discovery ──

		it("subagent discovers project-local test agents", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `discovery-${id}`);
			await sleep(1000);

			// Explicitly dispatch the project-local agent; no model-facing listing tool exists.
			const task = [
				`Call the subagent tool:`,
				`  label: "Disco-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
				`After you receive the subagent result, say DISCOVERY_DONE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// The test-echo agent (discovered from project .pi/agents/) should work
			const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
			assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
		});

		// ── Agent body identity prompt ──

		it("uses the definition Markdown body without per-call systemPrompt", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `sysprompt-${id}`);
			await sleep(1000);

			const task = [
				`Call the subagent tool with these parameters:`,
				`  label: "Body-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Write 'BODY_PROMPT_${id}' to ${markerFile} using bash: echo 'BODY_PROMPT_${id}' > '${markerFile}'"`,
				`After the subagent completes, say BODY_PROMPT_TEST_DONE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			const content = await waitForFile(markerFile, PI_TIMEOUT, /BODY_PROMPT/);
			assert.ok(content.includes(`BODY_PROMPT_${id}`), `Body prompt test marker should exist`);
		});

		it("loads an explicitly selected manual-only skill body on demand", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-selected-skill-${id}.txt`;
			trackTempFile(env, markerFile);
			const surface = createTrackedSurface(env, `selected-skill-${id}`);
			await sleep(1000);
			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "Skill-${id}"`,
				`  agent: "test-skill"`,
				`  task: "Apply manual-selected by reading its SKILL.md, then run: echo 'SELECTED_SKILL_${id}' > '${markerFile}'. Do not use unselected-integration."`,
				`After completion, say SELECTED_SKILL_DONE_${id}.`,
			].join("\n");
			startPi(surface, env.dir, task);
			let content: string;
			try {
				content = await waitForFile(markerFile, PI_TIMEOUT, /SELECTED_SKILL_/);
			} catch (error) {
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\nScreen:\n${readPane(surface, 300)}`,
				);
			}
			assert.match(content, new RegExp(`SELECTED_SKILL_${id}`));
			const screen = await waitForScreen(
				surface,
				new RegExp(`SELECTED_SKILL_DONE_${id}|completed`, "i"),
				PI_TIMEOUT,
				300,
			);
			assert.doesNotMatch(screen, /UNSELECTED_SECRET_BODY/);
			const inspection = await waitForInspection(env, (value) => value.agent === "test-skill");
			assert.equal((inspection.systemPrompt.match(/<available_skills>/g) ?? []).length, 1);
			assert.match(inspection.systemPrompt, /<name>manual-selected<\/name>/);
			assert.doesNotMatch(inspection.systemPrompt, /UNSELECTED_SECRET_BODY|<name>unselected-integration<\/name>/);
		});

		it("loads mixed manual-only and normal selected skills in order", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-mixed-skill-${id}.txt`;
			trackTempFile(env, markerFile);
			const surface = createTrackedSurface(env, `mixed-skill-${id}`);
			await sleep(1000);
			const task = `Call subagent with agent: "test-skill-mixed" and task: "Read both selected skills in order, then echo 'MIXED_SKILL_${id}' > '${markerFile}'".`;
			startPi(surface, env.dir, task);
			const content = await waitForFile(markerFile, PI_TIMEOUT, /MIXED_SKILL_/);
			assert.match(content, new RegExp(`MIXED_SKILL_${id}`));
		});

		it("preserves interactive ask for an explicitly selected skill", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-ask-skill-${id}.txt`;
			trackTempFile(env, markerFile);
			const surface = createTrackedSurface(env, `ask-skill-${id}`);
			await sleep(1000);
			const permissionExtension = PERMISSION_EXTENSION;
			const task = `Call the subagent tool with agent: "test-skill-ask" and task: "Read manual-selected, then echo 'ASK_SKILL_${id}' > '${markerFile}'".`;
			const { identity } = startPi(surface, env.dir, task, {
				extraArgs: `-e ${JSON.stringify(permissionExtension)}`,
			});
			const layout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			const child = layout.panes.find((pane) => pane.paneId !== identity.paneId)?.paneId;
			assert.ok(child);
			await waitForScreen(child, /Permission Required[\s\S]*manual-selected/i, PI_TIMEOUT, 300);
			execFileSync("herdr", ["pane", "send-keys", child, "y"]);
			await sleep(2000);
			execFileSync("herdr", ["pane", "send-keys", child, "y"]);
			let content: string;
			try {
				content = await waitForFile(markerFile, PI_TIMEOUT, /ASK_SKILL_/);
			} catch (error) {
				let childScreen = "<child pane already closed>";
				let parentScreen = "<parent unavailable>";
				try {
					childScreen = readPane(child, 300);
				} catch {}
				try {
					parentScreen = readPane(surface, 300);
				} catch {}
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\nChild:\n${childScreen}\nParent:\n${parentScreen}`,
				);
			}
			assert.match(content, new RegExp(`ASK_SKILL_${id}`));
		});

		it("lets the real permission sanitizer remove a denied selected skill", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-denied-skill-${id}.txt`;
			trackTempFile(env, markerFile);
			const surface = createTrackedSurface(env, `denied-skill-${id}`);
			await sleep(1000);
			const permissionExtension = PERMISSION_EXTENSION;
			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "DeniedSkill-${id}"`,
				`  agent: "test-skill-deny"`,
				`  task: "Run exactly: echo 'SKILL_DENIED_${id}' > '${markerFile}'. Do not inspect the environment."`,
			].join("\n");
			const { identity } = startPi(surface, env.dir, task, {
				extraArgs: `-e ${JSON.stringify(permissionExtension)}`,
			});
			const layout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			const child = layout.panes.find((pane) => pane.paneId !== identity.paneId)?.paneId;
			assert.ok(child);
			let content: string;
			try {
				content = await waitForFile(markerFile, PI_TIMEOUT, /SKILL_DENIED_/);
			} catch (error) {
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\nChild:\n${readPane(child, 300)}\nParent:\n${readPane(surface, 300)}`,
				);
			}
			assert.match(content, new RegExp(`SKILL_DENIED_${id}`));
			const inspection = await waitForInspection(env, (value) => value.agent === "test-skill-deny");
			assert.doesNotMatch(inspection.systemPrompt, /<name>manual-selected<\/name>/);
		});

		it("keeps selected skill reads governed by path policy", async () => {
			const id = uniqueId();
			const surface = createTrackedSurface(env, `path-skill-${id}`);
			await sleep(1000);
			const permissionExtension = PERMISSION_EXTENSION;
			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "PathSkill-${id}"`,
				`  agent: "test-skill-path"`,
				`  task: "Attempt to read manual-selected/SKILL.md. If denied, run exactly: echo 'PATH_SKILL_FALLBACK_${id}' > '/tmp/pi-integ-path-skill-${id}.txt'"`,
			].join("\n");
			const markerFile = `/tmp/pi-integ-path-skill-${id}.txt`;
			trackTempFile(env, markerFile);
			const { identity } = startPi(surface, env.dir, task, {
				extraArgs: `-e ${JSON.stringify(permissionExtension)}`,
			});
			const childLayout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			const child = childLayout.panes.find((pane) => pane.paneId !== identity.paneId)?.paneId;
			assert.ok(child);
			const content = await waitForFile(markerFile, PI_TIMEOUT, /PATH_SKILL_FALLBACK_/);
			assert.match(content, new RegExp(`PATH_SKILL_FALLBACK_${id}`));
		});

		it("keeps selected skill reads governed by external-directory policy", async () => {
			const id = uniqueId();
			const externalRoot = `/tmp/pi-integ-external-skill-${id}`;
			const externalSkillDir = join(externalRoot, "external-selected");
			const linkedSkillDir = join(env.dir, ".pi", "skills", "external-selected");
			const markerFile = join(env.dir, `external-skill-marker-${id}.txt`);
			mkdirSync(externalSkillDir, { recursive: true });
			writeFileSync(
				join(externalSkillDir, "SKILL.md"),
				[
					"---",
					"name: external-selected",
					"description: External selected skill",
					"---",
					"EXTERNAL_SELECTED_BODY",
				].join("\n"),
			);
			symlinkSync(externalSkillDir, linkedSkillDir, "dir");
			trackTempFile(env, markerFile);
			try {
				const surface = createTrackedSurface(env, `external-skill-${id}`);
				await sleep(1000);
				const task = [
					`Call the subagent tool with these EXACT parameters:`,
					`  label: "ExternalSkill-${id}"`,
					`  agent: "test-skill-external"`,
					`  task: "Attempt to read external-selected/SKILL.md. If denied, run exactly: echo 'EXTERNAL_SKILL_FALLBACK_${id}' > '${markerFile}'"`,
				].join("\n");
				const { identity } = startPi(surface, env.dir, task, {
					extraArgs: `-e ${JSON.stringify(PERMISSION_EXTENSION)}`,
				});
				const layout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
				const child = layout.panes.find((pane) => pane.paneId !== identity.paneId)?.paneId;
				assert.ok(child);
				const content = await waitForFile(markerFile, PI_TIMEOUT, /EXTERNAL_SKILL_FALLBACK_/);
				assert.match(content, new RegExp(`EXTERNAL_SKILL_FALLBACK_${id}`));
			} finally {
				rmSync(externalRoot, { recursive: true, force: true });
			}
		});

		it("preserves direct child-TTY ask approval with the real permission extension", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-permission-ask-${id}.txt`;
			trackTempFile(env, markerFile);
			const surface = createTrackedSurface(env, `permission-ask-${id}`);
			await sleep(1000);
			const permissionExtension = PERMISSION_EXTENSION;
			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "Ask-${id}"`,
				`  agent: "test-ask"`,
				`  task: "Run: echo 'ASK_ALLOWED_${id}' > '${markerFile}'"`,
			].join("\n");
			const { identity } = startPi(surface, env.dir, task, {
				extraArgs: `-e ${JSON.stringify(permissionExtension)}`,
			});
			const layout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			const child = layout.panes.find((pane) => pane.paneId !== identity.paneId)?.paneId;
			assert.ok(child, "permission ask child pane must exist");
			await waitForScreen(child, /Permission Required[\s\S]*Allow this command\?/i, PI_TIMEOUT, 300);
			execFileSync("herdr", ["pane", "send-keys", child, "y"]);
			await sleep(2000);
			execFileSync("herdr", ["pane", "send-keys", child, "y"]);
			let content: string;
			try {
				content = await waitForFile(markerFile, PI_TIMEOUT, /ASK_ALLOWED_/);
			} catch (error) {
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\nChild:\n${readPane(child, 300)}\nParent:\n${readPane(surface, 300)}`,
				);
			}
			assert.match(content, new RegExp(`ASK_ALLOWED_${id}`));
		});

		it("keeps the parent subagent tool hidden despite agent tools and allow policy", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-hidden-tools-${id}.txt`;
			trackTempFile(env, markerFile);
			const surface = createTrackedSurface(env, `hidden-tools-${id}`);
			await sleep(1000);
			const permissionExtension = PERMISSION_EXTENSION;
			const task = [
				`Call the subagent tool with agent: "test-hidden", label: "Hidden-${id}",`,
				`and task: "If subagent is unavailable, run: echo 'TOOLS_HIDDEN_${id}' > '${markerFile}'".`,
			].join("\n");
			startPi(surface, env.dir, task, { extraArgs: `-e ${JSON.stringify(permissionExtension)}` });
			const content = await waitForFile(markerFile, PI_TIMEOUT, /TOOLS_HIDDEN_/);
			assert.match(content, new RegExp(`TOOLS_HIDDEN_${id}`));
			const inspection = await waitForInspection(env, (value) => value.agent === "test-hidden");
			assert.equal(inspection.activeTools.includes("subagent"), false);
			assert.equal(inspection.activeTools.includes("subagent_done"), true);
		});

		it("inherits the exact global agent root with real permission identity", async () => {
			const id = uniqueId();
			const agentId = `test-global-${id}`;
			const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
			const agentPath = join(agentDir, "agents", `${agentId}.md`);
			const markerFile = `/tmp/pi-integ-global-agent-${id}.txt`;
			trackTempFile(env, markerFile);
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			writeFileSync(
				agentPath,
				[
					"---",
					`name: ${agentId}`,
					"tools: bash",
					"seed: fresh",
					"permission:",
					"  bash: allow",
					"---",
					"Run the exact requested bash command immediately.",
				].join("\n"),
			);
			try {
				const surface = createTrackedSurface(env, `global-agent-${id}`);
				await sleep(1000);
				const permissionExtension = PERMISSION_EXTENSION;
				const task = `Call subagent with agent: "${agentId}" and task: "echo 'GLOBAL_AGENT_${id}' > '${markerFile}'".`;
				startPi(surface, env.dir, task, { extraArgs: `-e ${JSON.stringify(permissionExtension)}` });
				const content = await waitForFile(markerFile, PI_TIMEOUT, /GLOBAL_AGENT_/);
				assert.match(content, new RegExp(`GLOBAL_AGENT_${id}`));
			} finally {
				try {
					unlinkSync(agentPath);
				} catch {}
			}
		});

		it("loads the real permission extension and enforces per-agent deny", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-permission-deny-${id}.txt`;
			trackTempFile(env, markerFile);
			const surface = createTrackedSurface(env, `permission-${id}`);
			await sleep(1000);
			const permissionExtension = PERMISSION_EXTENSION;
			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "Deny-${id}"`,
				`  agent: "test-deny"`,
				`  task: "Run: echo 'MUST_NOT_EXIST_${id}' > '${markerFile}'"`,
				`After the result, say PERMISSION_DENY_DONE_${id}.`,
			].join("\n");
			startPi(surface, env.dir, task, { extraArgs: `-e ${JSON.stringify(permissionExtension)}` });
			const screen = await waitForScreen(
				surface,
				new RegExp(`PERMISSION_DENY_DONE_${id}|not permitted|permission`, "i"),
				PI_TIMEOUT,
				300,
			);
			assert.equal(existsSync(markerFile), false, "per-agent bash deny must prevent marker creation");
			assert.match(screen, /not permitted|denied|permission/i);
		});
	});
}
