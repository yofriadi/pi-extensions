/**
 * Integration tests for blocking mode, abort-during-blocking, resume-region,
 * and attached layout (1–4 children) — OpenSpec task 8.2.
 *
 * Requires real herdr + PI_TEST_MODEL. Run with:
 *   PI_TEST_MODEL="tokenrouter/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 \
 *     node --test --test-concurrency=1 test/integration/blocking-layout.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	cleanupTestEnv,
	closePane,
	countSubagentResultSteers,
	createTestEnv,
	createTrackedSurface,
	getAvailableBackends,
	getPaneIdentity,
	herdrPaneExists,
	interruptPane,
	PI_TIMEOUT,
	restoreBackend,
	setBackend,
	sleep,
	startPi,
	type TestEnv,
	trackTempFile,
	uniqueId,
	waitForChildPaneCount,
	waitForFile,
	waitForPaneGone,
	waitForScreen,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
	console.log("⚠️  herdr is unavailable — skipping blocking/layout integration tests");
}

for (const backend of backends) {
	describe(`blocking-layout [${backend}]`, { timeout: PI_TIMEOUT * 4, concurrency: 1 }, () => {
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

		// ── Blocking e2e ──

		it("blocking spawn returns tool result text without completion steers", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-block-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `block-${id}`);
			await sleep(800);

			const sessionsDir = join(env.dir, ".pi-sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const parentSession = join(sessionsDir, `parent-block-${id}.jsonl`);
			// Minimal empty session file — pi --session will append.
			writeFileSync(parentSession, "", "utf8");
			trackTempFile(env, parentSession);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "Block-${id}"`,
				`  agent: "test-echo"`,
				`  blocking: true`,
				`  task: "Run this bash command: echo 'BLOCK_PASS_${id}' > '${markerFile}'"`,
				`Do not do anything else before calling subagent.`,
				`When the subagent tool returns, the tool result itself must contain the child's outcome.`,
				`Then say BLOCKING_COMPLETE_${id}.`,
			].join("\n");

			const { identity } = startPi(surface, env.dir, task, { sessionFile: parentSession });

			// Child writes marker
			const content = await waitForFile(markerFile, PI_TIMEOUT, /BLOCK_PASS_/);
			assert.ok(content.includes(`BLOCK_PASS_${id}`));

			// Parent sees completion phrase (from its own turn after tool result)
			await waitForScreen(surface, new RegExp(`BLOCKING_COMPLETE_${id}`), PI_TIMEOUT);

			// Give JSONL a moment to flush
			await sleep(1500);

			// No async completion steers for blocking mode
			const steers = countSubagentResultSteers(parentSession);
			assert.equal(
				steers,
				0,
				`blocking spawn must not deliver subagent_result steers; found ${steers} in ${parentSession}`,
			);

			// Attached: at least one child pane was created under the parent surface's tab
			// (may already be closed after auto-exit — just assert parent identity was used)
			assert.ok(identity.paneId, "parent surface identity should be known");
			assert.equal(getPaneIdentity(surface).paneId, identity.paneId);
		});

		// ── Abort during blocking ──

		it("ESC on parent during blocking cancels and closes the child pane", async () => {
			const id = uniqueId();
			const startFile = `/tmp/pi-integ-abort-start-${id}.txt`;
			trackTempFile(env, startFile);

			const surface = createTrackedSurface(env, `abort-${id}`);
			await sleep(800);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "Abort-${id}"`,
				`  agent: "test-echo"`,
				`  blocking: true`,
				`  task: "Run this bash command: echo 'ABORT_START_${id}' > '${startFile}'; sleep 120"`,
				`Do nothing else. Just call subagent once and wait.`,
			].join("\n");

			const { identity } = startPi(surface, env.dir, task);

			// Wait until child has started (marker written)
			await waitForFile(startFile, PI_TIMEOUT, /ABORT_START_/);

			// Child should be present in the attached region
			const layout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			const children = layout.panes.filter((p) => p.paneId !== identity.paneId);
			assert.ok(children.length >= 1, "expected at least one child pane during blocking sleep");
			const childId = children[0].paneId;

			// ESC the parent pi pane (aborts the blocking tool call)
			interruptPane(surface);

			// Child pane should close
			await waitForPaneGone(childId, PI_TIMEOUT);

			// Parent screen should show cancelled/error-ish outcome eventually
			// (wording varies; accept cancelled / error / failed / interrupted)
			try {
				await waitForScreen(
					surface,
					/cancel|error|fail|interrupt|abort|Layout warning|BLOCK/i,
					Math.min(PI_TIMEOUT, 60_000),
				);
			} catch {
				// Soft: pane-gone is the hard assertion; screen text is best-effort
			}
		});

		// ── Resume opens region ──
		it("subagent_resume opens a pane in the parent's attached region", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-resume-${id}.txt`;
			const sessionPathFile = `/tmp/pi-integ-resume-sess-${id}.txt`;
			const followFile = `/tmp/pi-integ-resume-follow-${id}.txt`;
			trackTempFile(env, markerFile);
			trackTempFile(env, sessionPathFile);
			trackTempFile(env, followFile);

			// Keep the seed and resume in one Pi process. Owner metadata binds the
			// resumable child to this exact parent session identity.
			const sessionsDir = join(env.dir, ".pi-sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const parentSession = join(sessionsDir, `parent-resume-${id}.jsonl`);
			writeFileSync(parentSession, "", "utf8");
			trackTempFile(env, parentSession);
			const surface = createTrackedSurface(env, `resume-${id}`);
			await sleep(800);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  label: "ResumeSeed-${id}"`,
				`  agent: "test-echo"`,
				`  blocking: true`,
				`  task: "Run this bash: echo 'SEED_${id}' > '${markerFile}'; echo $PI_SUBAGENT_SESSION > '${sessionPathFile}'"`,
				`When the blocking result returns, it includes the exact Session path. Immediately call subagent_resume with that path,`,
				`  label: "ResumeFollow-${id}"`,
				`  message: "Run: echo 'FOLLOW_${id}' > '${followFile}'"`,
				`Do not start another parent session. After the resume completes, say RESUME_REGION_DONE_${id}.`,
			].join("\n");

			const { identity } = startPi(surface, env.dir, task, { sessionFile: parentSession });
			await waitForFile(markerFile, PI_TIMEOUT, /SEED_/);
			const sessionPath = (await waitForFile(sessionPathFile, PI_TIMEOUT, /\.jsonl/)).trim();
			assert.ok(existsSync(sessionPath), `seed session should exist: ${sessionPath}`);
			// The seed marker and session path are durable; the parent may already have
			// advanced to the resume before the transient seed acknowledgement is rendered.

			const layout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			const children = layout.panes.filter((p) => p.paneId !== identity.paneId);
			assert.ok(children.length >= 1, "resume should open a child pane beside parent");
			for (const child of children) {
				assert.equal(getPaneIdentity(child.paneId).tabId, identity.tabId);
			}

			await waitForFile(followFile, PI_TIMEOUT, /FOLLOW_/);
			try {
				await waitForScreen(surface, new RegExp(`RESUME_REGION_DONE_${id}`), Math.min(PI_TIMEOUT, 60_000));
			} catch {
				// FOLLOW marker is the hard assertion; phrase is best-effort under model variance
			}
			assert.equal(getPaneIdentity(surface).tabId, identity.tabId);
		});

		it("delivers one async completion through an actual extension reload", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-reload-async-${id}.txt`;
			const parentSession = `/tmp/pi-integ-reload-parent-${id}.jsonl`;
			trackTempFile(env, markerFile);
			trackTempFile(env, `${markerFile}.reloaded`);
			trackTempFile(env, parentSession);
			const surface = createTrackedSurface(env, `reload-async-${id}`);
			await sleep(800);
			const task = `Call subagent with agent: "test-echo", label: "ReloadAsync-${id}", task: "echo 'RELOAD_ASYNC_${id}' > '${markerFile}'; sleep 15". Immediately after the launch acknowledgement, end your response without waiting for completion.`;
			const reloadExtension = join(process.cwd(), "test", "integration", "reload-trigger.ts");
			const { identity } = startPi(surface, env.dir, "/test-reload", {
				sessionFile: parentSession,
				extraArgs: `-e ${JSON.stringify(reloadExtension)}`,
				env: { PI_TEST_RELOAD_MARKER: markerFile, PI_TEST_RELOAD_TASK: task },
			});
			await waitForFile(markerFile, PI_TIMEOUT, /RELOAD_ASYNC_/);
			await waitForFile(`${markerFile}.reloaded`, PI_TIMEOUT, /reload/);
			await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			await waitForScreen(surface, /ReloadAsync.*\[[a-f0-9]{32}\].*completed/is, PI_TIMEOUT, 300);
			assert.equal(countSubagentResultSteers(parentSession), 1);
		});

		it("resets an empty attached region after manual close", async () => {
			const id = uniqueId();
			const firstFile = `/tmp/pi-integ-empty-first-${id}.txt`;
			const secondFile = `/tmp/pi-integ-empty-second-${id}.txt`;
			trackTempFile(env, firstFile);
			trackTempFile(env, secondFile);
			const surface = createTrackedSurface(env, `empty-region-${id}`);
			await sleep(800);
			const task = [
				`Call subagent with agent: "test-echo", label: "Empty-${id}", task: "echo FIRST_${id} > '${firstFile}'; sleep 90".`,
				`If that run fails or its pane disappears, call subagent again with agent: "test-echo", label: "Empty-${id}",`,
				`task: "echo SECOND_${id} > '${secondFile}'".`,
			].join("\n");
			const { identity } = startPi(surface, env.dir, task);
			await waitForFile(firstFile, PI_TIMEOUT, /FIRST_/);
			const firstLayout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			const firstChild = firstLayout.panes.find((pane) => pane.paneId !== identity.paneId)?.paneId;
			assert.ok(firstChild);
			closePane(firstChild);
			await waitForPaneGone(firstChild, 30_000);
			const content = await waitForFile(secondFile, PI_TIMEOUT, /SECOND_/);
			assert.match(content, new RegExp(`SECOND_${id}`));
			assert.equal(herdrPaneExists(identity.paneId), true);
		});

		it("blocking ping settles foreground and later resume runs as background", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-ping-resume-${id}.txt`;
			trackTempFile(env, markerFile);
			const surface = createTrackedSurface(env, `ping-resume-${id}`);
			await sleep(800);
			const task = [
				`Call subagent with agent: "test-ping-resume", label: "PingResume-${id}", blocking: true, task: "INITIAL_PING ${id}".`,
				`When the blocking result says NEED_RESUME and gives a Session path, call subagent_resume with that path,`,
				`label: "PingResume-${id}", and message: "Run: echo 'PING_RESUMED_${id}' > '${markerFile}'".`,
				`After the async resume completion arrives, say PING_RESUME_DONE_${id}.`,
			].join("\n");
			startPi(surface, env.dir, task);
			const content = await waitForFile(markerFile, PI_TIMEOUT, /PING_RESUMED_/);
			assert.match(content, new RegExp(`PING_RESUMED_${id}`));
			const screen = await waitForScreen(surface, /PING_RESUME_DONE|resumed|completed/i, PI_TIMEOUT, 300);
			assert.match(screen, /NEED_RESUME|resumed|completed/i);
		});

		it("attached layout stacks long-lived children beside main (direction:right)", async () => {
			const id = uniqueId();
			const startA = `/tmp/pi-integ-lay-a-${id}.txt`;
			const startB = `/tmp/pi-integ-lay-b-${id}.txt`;
			for (const f of [startA, startB]) trackTempFile(env, f);

			const surface = createTrackedSurface(env, `layout-${id}`);
			await sleep(800);

			// Two long-lived children — enough to prove first right split + subsequent down stack.
			// (Three concurrent LLM children are flaky under free-tier rate limits.)
			const task = [
				`Call the subagent tool TWICE before waiting for results.`,
				``,
				`First:`,
				`  label: "LayA-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'LAY_A_${id}' > '${startA}'; sleep 60"`,
				``,
				`Second:`,
				`  label: "LayB-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'LAY_B_${id}' > '${startB}'; sleep 60"`,
				``,
				`Call both NOW. After both complete, say LAYOUT_STACK_DONE_${id}.`,
			].join("\n");

			const { identity } = startPi(surface, env.dir, task);

			// Prefer geometry observation as soon as panes appear (don't wait only on markers —
			// free models sometimes stall one of two parallel children).
			const layout = await waitForChildPaneCount(identity.paneId, 2, PI_TIMEOUT);
			const parentRect = layout.panes.find((p) => p.paneId === identity.paneId)?.rect;
			const children = layout.panes.filter((p) => p.paneId !== identity.paneId);
			assert.ok(parentRect, "parent pane should appear in layout");
			assert.ok(children.length >= 2, `expected ≥2 children, got ${children.length}`);

			const areaW = layout.area?.width ?? parentRect.width + Math.max(...children.map((c) => c.rect.width));
			assert.ok(
				parentRect.width >= areaW * 0.35,
				`main width ${parentRect.width} should be ~half of area ${areaW}`,
			);

			for (const child of children) {
				assert.ok(
					child.rect.x >= parentRect.x + parentRect.width - 2,
					`child ${child.paneId} x=${child.rect.x} should be right of main`,
				);
			}

			const xs = children.map((c) => c.rect.x);
			const ys = children.map((c) => c.rect.y).sort((a, b) => a - b);
			assert.ok(Math.max(...xs) - Math.min(...xs) <= 3, "children should share x column");
			if (children.length >= 2) {
				assert.ok(ys[ys.length - 1] > ys[0], "children should be stacked on y");
			}

			for (const child of children) {
				const meta = getPaneIdentity(child.paneId);
				assert.equal(meta.tabId, identity.tabId, `child ${child.paneId} should share parent tab`);
			}

			// Mid-run close one child
			const victim = children[0].paneId;
			closePane(victim);
			await waitForPaneGone(victim, 30_000);
			assert.equal(herdrPaneExists(victim), false);
			assert.equal(herdrPaneExists(identity.paneId), true);

			// Best-effort: markers may still arrive
			try {
				await waitForFile(startA, 30_000, /LAY_A_/);
			} catch {
				/* optional under model flakiness */
			}
		});

		it("external abort cancels a queued foreground call before it can launch", async () => {
			const id = uniqueId();
			const firstFile = `/tmp/pi-integ-queued-fg-first-${id}.txt`;
			const queuedFile = `/tmp/pi-integ-queued-fg-second-${id}.txt`;
			trackTempFile(env, firstFile);
			trackTempFile(env, queuedFile);
			const surface = createTrackedSurface(env, `queued-fg-${id}`);
			await sleep(800);
			const task = [
				`Call subagent TWICE in one response. Both calls use blocking: true.`,
				`First: agent "test-echo", label "QueuedFG-${id}", task "echo FIRST_${id} > '${firstFile}'; sleep 60".`,
				`Second: agent "test-echo", label "QueuedFG-${id}", task "echo SECOND_${id} > '${queuedFile}'".`,
				`Do not wait between tool calls.`,
			].join("\n");
			const { identity } = startPi(surface, env.dir, task);
			const layout = await waitForChildPaneCount(identity.paneId, 1, PI_TIMEOUT);
			assert.equal(layout.panes.filter((pane) => pane.paneId !== identity.paneId).length, 1);
			await waitForScreen(surface, /queued|blocking/i, PI_TIMEOUT, 300);
			interruptPane(surface);
			await sleep(5_000);
			assert.equal(existsSync(queuedFile), false, "aborted queued foreground must never launch");
		});

		it("admits one foreground plus four background and queues overflow with duplicate labels", async () => {
			const id = uniqueId();
			const files = Array.from({ length: 6 }, (_, i) => `/tmp/pi-integ-capacity-${id}-${i}.txt`);
			for (const file of files) trackTempFile(env, file);
			const surface = createTrackedSurface(env, `capacity-${id}`);
			await sleep(800);
			const calls = [
				...Array.from({ length: 5 }, (_, i) =>
					[
						`Background ${i + 1}:`,
						`  label: "Duplicate-${id}"`,
						`  agent: "test-echo"`,
						`  task: "Run: echo 'CAP_${i}_${id}' > '${files[i]}'; sleep 25"`,
					].join("\n"),
				),
				[
					`Foreground:`,
					`  label: "Duplicate-${id}"`,
					`  agent: "test-echo"`,
					`  blocking: true`,
					`  task: "Run: echo 'CAP_5_${id}' > '${files[5]}'; sleep 15"`,
				].join("\n"),
			];
			const task = [
				`Call subagent SIX times in one response before waiting. Use these exact calls:`,
				...calls,
				`After all calls/results, say CAPACITY_DONE_${id}.`,
			].join("\n\n");
			const { identity } = startPi(surface, env.dir, task);
			const layout = await waitForChildPaneCount(identity.paneId, 5, PI_TIMEOUT);
			assert.ok(layout.panes.filter((pane) => pane.paneId !== identity.paneId).length >= 5);
			const widget = await waitForScreen(surface, /queued|5 active|foreground|background/i, PI_TIMEOUT, 300);
			assert.match(widget, /Duplicate-/);
			assert.match(widget, /\[[a-f0-9]{32}\]/i);
			for (const child of layout.panes.filter((pane) => pane.paneId !== identity.paneId)) {
				try {
					closePane(child.paneId);
				} catch {}
			}
		});
	});
}
