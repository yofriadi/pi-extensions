import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import subagentsExtension, * as subagentsModule from "../src/index.ts";
import { resolveSelectedSkills } from "../src/skills.ts";
import { createPlainWidgetTheme } from "./widget-theme.ts";

const testApi = (subagentsModule as any).__test__;
const widgetTheme = createPlainWidgetTheme();

/** Fake ExtensionAPI with handler capture, mirroring Pi's factory contract. */
function fakeExtensionPi() {
	const handlers: Record<string, Function> = {};
	const sends: unknown[] = [];
	const wakes: unknown[] = [];
	const pi: any = {
		handlers,
		sends,
		wakes,
		on(name: string, fn: Function) {
			handlers[name] = fn;
		},
		registerTool() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		sendMessage(message: unknown, _options?: unknown) {
			sends.push(message);
		},
		sendUserMessage(message: unknown, _options?: unknown) {
			wakes.push(message);
		},
	};
	return pi;
}

function fakeCtx(sessionId: string, sessionFile?: string) {
	return {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getSessionDir: () => tmpdir(),
		},
		ui: { setWidget() {} },
		isProjectTrusted: () => true,
	};
}

function resultMessage(runId: string) {
	return {
		customType: "subagent_result",
		content: "done",
		display: true,
		details: { id: runId, name: "t", task: "x", agent: "t" },
	};
}

beforeEach(() => {
	testApi.stopDeliveryRetry();
	testApi.resetActiveCompletionRuntime();
});

afterEach(() => {
	testApi.stopDeliveryRetry();
	testApi.resetActiveCompletionRuntime();
});

it("snapshots queued launch inputs before the parent context can be invalidated", () => {
	const original: any = {
		cwd: "/project-before-reload",
		model: { provider: "tokenrouter", id: "gpt-5.6-luna" },
		modelRegistry: {
			find() {
				return undefined;
			},
		},
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionFile: () => "/tmp/parent-before.jsonl",
			getSessionId: () => "parent-before",
			getSessionDir: () => "/tmp/parent-before",
		},
	};
	const stable = testApi.snapshotParentContext(original);
	original.cwd = "/project-after-reload";
	original.sessionManager.getSessionFile = () => {
		throw new Error("invalidated context");
	};
	assert.equal(stable.cwd, "/project-before-reload");
	assert.equal(stable.sessionFile, "/tmp/parent-before.jsonl");
	assert.equal(stable.sessionId, "parent-before");
	assert.equal(stable.sessionDir, "/tmp/parent-before");
	assert.equal(stable.projectTrusted, true);
});

describe("discovery-only factory isolation", () => {
	it("a discovery-only factory invocation cannot replace the active parent completion record", () => {
		// Topology regression: the selected-skill resolver's standalone resource
		// loader evaluates configured extension factories with an UNBOUND runtime.
		// Factory evaluation alone must never publish a delivery API.
		const parent = fakeExtensionPi();
		subagentsExtension(parent);
		const parentCtx = fakeCtx("parent-session");
		parent.handlers.session_start({}, parentCtx);
		const active = testApi.resolveActiveCompletionRuntime("parent-session");
		assert.ok(active, "session_start activated the parent runtime");
		assert.equal(active.api, parent);

		// Discovery-only evaluation: factory runs, no session_start ever follows.
		const discovery = fakeExtensionPi();
		subagentsExtension(discovery);

		const after = testApi.resolveActiveCompletionRuntime("parent-session");
		assert.equal(after.api, parent, "active record still belongs to the bound parent session");
		assert.equal(after.generation, active.generation, "no re-activation occurred");
		assert.equal(discovery.sends.length, 0);
	});

	it("factory evaluation alone publishes no completion API at all", () => {
		const discovery = fakeExtensionPi();
		subagentsExtension(discovery);
		assert.equal(
			testApi.resolveActiveCompletionRuntime("any-session"),
			undefined,
			"no session_start → no active record",
		);
	});

	it("a fresh discovery-only module import cannot clear active widget/status/retry timers", async () => {
		// Regression for module-level timer takeover: a fresh uncached import is
		// representative of the standalone discovery loader's module evaluation.
		// It never emits session_start, so it must not clear timers owned by the
		// live session module or leave its local timer variables stale/non-null.
		const pi = fakeExtensionPi();
		const sessionId = "timer-parent";
		const pendingId = "timer-pending";
		const pending: any = {
			id: pendingId,
			parentSessionId: sessionId,
			message: resultMessage(pendingId),
			attempts: 0,
			nextRetryAt: Date.now() + 60_000,
			delivering: false,
			generation: 1,
		};
		testApi.pendingDeliveries.set(pendingId, pending);
		let widgetRenders = 0;
		const ctx: any = fakeCtx(sessionId);
		ctx.hasUI = true;
		ctx.ui = {
			setWidget() {
				widgetRenders++;
			},
		};
		try {
			subagentsExtension(pi);
			pi.handlers.session_start({}, ctx);
			const before = testApi.timerSnapshot();
			assert.ok(before.widget, "live widget timer started");
			assert.ok(before.status, "live status timer started");
			assert.ok(before.deliveryRetry, "live delivery-retry timer started");
			const rendersBeforeDiscovery = widgetRenders;

			const discoveryModule = await import(`../src/index.ts?discovery-timer=${Date.now()}`);
			const after = discoveryModule.__test__.timerSnapshot();
			assert.strictEqual(after.widget, before.widget, "discovery did not clear the widget timer");
			assert.strictEqual(after.status, before.status, "discovery did not clear the status timer");
			assert.strictEqual(after.deliveryRetry, before.deliveryRetry, "discovery did not clear the retry timer");

			// Wait across one interval tick: the live module's callback continues to
			// run after discovery, not merely leaves a stale global handle behind.
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			const afterTick = testApi.timerSnapshot();
			assert.strictEqual(afterTick.status, before.status, "the live status timer survived its tick");
			assert.strictEqual(afterTick.deliveryRetry, before.deliveryRetry, "the live retry timer survived its tick");
			assert.ok(widgetRenders > rendersBeforeDiscovery, "the live widget timer continued running");
		} finally {
			pi.handlers.session_shutdown?.({ reason: "quit" }, ctx);
			testApi.pendingDeliveries.delete(pendingId);
			testApi.resetActiveCompletionRuntime();
		}
	});

	it("selected-skill resolution runs no extension factory and leaves the active record unchanged", async () => {
		// Non-vacuity: the fixture project ships BOTH an ordinary skill (which the
		// resolver must still enumerate) and an extension whose factory would write
		// a marker file if it were ever executed.
		const cwd = mkdtempSync(join(tmpdir(), "resolve-skills-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "resolve-skills-agent-"));
		try {
			const skillDir = join(cwd, ".pi", "skills", "fixture-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				["---", "name: fixture-skill", "description: Fixture", "---", "BODY"].join("\n"),
			);
			const extDir = join(cwd, ".pi", "extensions");
			mkdirSync(extDir, { recursive: true });
			const marker = join(cwd, "factory-ran.marker");
			writeFileSync(
				join(extDir, "marker-extension.ts"),
				`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "ran"); }\n`,
			);

			const parent = fakeExtensionPi();
			subagentsExtension(parent);
			parent.handlers.session_start({}, fakeCtx("parent-session"));
			const before = testApi.resolveActiveCompletionRuntime("parent-session");

			const selected = await resolveSelectedSkills({
				raw: "fixture-skill",
				cwd,
				agentDir,
				projectTrusted: true,
			});
			assert.equal(selected.length, 1, "ordinary project skill still resolves");
			assert.equal(selected[0].name, "fixture-skill");
			assert.equal(existsSync(marker), false, "extension-free discovery: no factory executed");
			const after = testApi.resolveActiveCompletionRuntime("parent-session");
			assert.equal(after.api, parent, "active parent completion record unchanged");
			assert.equal(after.generation, before.generation);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("session-bound runtime ownership", () => {
	it("session_start activates the current API; session_shutdown clears only the owner's record", () => {
		const pi = fakeExtensionPi();
		subagentsExtension(pi);
		pi.handlers.session_start({}, fakeCtx("s1"));
		assert.equal(testApi.resolveActiveCompletionRuntime("s1").api, pi);
		pi.handlers.session_shutdown({ reason: "quit" }, fakeCtx("s1"));
		assert.equal(testApi.resolveActiveCompletionRuntime("s1"), undefined, "owner shutdown cleared the record");
	});

	it("a stale shutdown cannot clear a replacement session's active runtime", () => {
		// Reload: old instance shuts down AFTER the replacement already activated.
		const oldPi = fakeExtensionPi();
		subagentsExtension(oldPi);
		oldPi.handlers.session_start({}, fakeCtx("s1"));

		const newPi = fakeExtensionPi();
		subagentsExtension(newPi);
		newPi.handlers.session_start({}, fakeCtx("s1"));

		oldPi.handlers.session_shutdown({ reason: "reload" }, fakeCtx("s1"));
		const active = testApi.resolveActiveCompletionRuntime("s1");
		assert.ok(active, "replacement record survives the stale shutdown");
		assert.equal(active.api, newPi, "the replacement runtime is still active");
	});
});

describe("process-global delivery retry scheduling", () => {
	it("keeps deferred pending work bounded across a reload gap that never reactivates", async () => {
		const pi = fakeExtensionPi();
		const parentSessionId = "reload-gap-parent";
		const runId = "reload-gap-run";
		const ctx = fakeCtx(parentSessionId);
		subagentsExtension(pi);
		pi.handlers.session_start({}, ctx);
		try {
			testApi.queuePendingDeliveryWithVerification(
				runId,
				parentSessionId,
				resultMessage(runId),
				new testApi.SessionRuntimeUnavailableError(parentSessionId),
				{ expectedRunId: runId },
				0,
			);
			const pending = testApi.pendingDeliveries.get(runId);
			pending.deferredSince = Date.now() - testApi.DEFERRED_DELIVERY_MAX_MS - 1;
			pending.nextRetryAt = Date.now();
			const retryBeforeShutdown = testApi.timerSnapshot().deliveryRetry;
			assert.ok(retryBeforeShutdown, "queue started the process-global retry service");

			pi.handlers.session_shutdown({ reason: "reload" }, ctx);
			assert.strictEqual(
				testApi.timerSnapshot().deliveryRetry,
				retryBeforeShutdown,
				"reload shutdown preserved the retry service",
			);

			await new Promise((resolve) => setTimeout(resolve, 1_100));
			const after = testApi.pendingDeliveries.get(runId);
			assert.equal(after.exhausted, true, "the service enforced the deferral budget without reactivation");
			assert.equal(after.exhaustionCause, "deferral");
			assert.equal(after.attempts, 0, "runtime absence did not consume ordinary attempts");
		} finally {
			testApi.pendingDeliveries.delete(runId);
		}
	});

	it("an old watcher can schedule delivery after replacement session_start", async () => {
		const parentSessionId = "late-old-watcher-parent";
		const runId = "late-old-watcher-run";
		const dir = mkdtempSync(join(tmpdir(), "late-old-watcher-"));
		const sessionFile = join(dir, "parent.jsonl");
		writeFileSync(sessionFile, "");
		const oldPi = fakeExtensionPi();
		subagentsExtension(oldPi);
		oldPi.handlers.session_start({}, fakeCtx(parentSessionId, sessionFile));
		try {
			// A fresh module claims presentation/runtime ownership before the old
			// watcher's completion callback reaches its delivery catch path.
			const replacementModule = await import(`../src/index.ts?replacement-retry=${Date.now()}`);
			const newPi = fakeExtensionPi();
			newPi.sendMessage = (message: any) => {
				newPi.sends.push(message);
				appendFileSync(
					sessionFile,
					JSON.stringify({
						type: "custom_message",
						customType: message.customType,
						details: message.details,
					}) + "\n",
				);
			};
			replacementModule.default(newPi);
			newPi.handlers.session_start({}, fakeCtx(parentSessionId, sessionFile));
			oldPi.handlers.session_shutdown({ reason: "reload" }, fakeCtx(parentSessionId, sessionFile));

			// This call belongs to the OLD module closure, after replacement has
			// activated. Scheduling must be owner-neutral rather than silently no-op.
			testApi.queuePendingDeliveryWithVerification(
				runId,
				parentSessionId,
				resultMessage(runId),
				new Error("initial send failed"),
				{ sessionFile, expectedRunId: runId },
				1,
			);
			assert.ok(testApi.timerSnapshot().deliveryRetry, "old watcher started the shared retry service");

			const deadline = Date.now() + 4_000;
			while (testApi.pendingDeliveries.has(runId) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.equal(newPi.sends.length, 1, "replacement runtime delivered the old watcher's result once");
			assert.equal(testApi.pendingDeliveries.has(runId), false, "pending row settled");
			newPi.handlers.session_shutdown({ reason: "quit" }, fakeCtx(parentSessionId, sessionFile));
		} finally {
			testApi.pendingDeliveries.delete(runId);
			testApi.deliveredRunIds.delete(runId);
			testApi.inflightDelivery.delete(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("inactive-runtime delivery deferral", () => {
	it("defers before the barrier with zero action calls when no record is active", async () => {
		const dir = mkdtempSync(join(tmpdir(), "inactive-delivery-"));
		const sessionFile = join(dir, "parent.jsonl");
		writeFileSync(sessionFile, "");
		const runId = "inactive-run-1";
		const parentSessionId = `parent-${runId}`;
		try {
			await assert.rejects(
				testApi.deliverBackgroundMessage(undefined, parentSessionId, resultMessage(runId), {
					sessionFile,
					expectedRunId: runId,
					graceMs: 100,
				}),
				(error: unknown) => testApi.isSessionRuntimeUnavailable(error),
			);
			// Zero sends, zero wakes, zero dedup state — nothing was attempted.
			assert.equal(testApi.deliveredRunIds.has(runId), false);
			assert.equal(testApi.inflightDelivery.has(runId), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a session-mismatched record without touching its API", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mismatch-delivery-"));
		const sessionFile = join(dir, "parent.jsonl");
		writeFileSync(sessionFile, "");
		const runId = "mismatch-run-1";
		try {
			const other = fakeExtensionPi();
			subagentsExtension(other);
			other.handlers.session_start({}, fakeCtx("other-session"));
			await assert.rejects(
				testApi.deliverBackgroundMessage(undefined, "target-session", resultMessage(runId), {
					sessionFile,
					expectedRunId: runId,
					graceMs: 100,
				}),
				(error: unknown) => testApi.isSessionRuntimeUnavailable(error),
			);
			assert.equal(other.sends.length, 0, "the other session's API was never called");
			assert.equal(other.wakes.length, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a deferred pending delivery sends exactly once after activation, consuming no attempts while inactive", async () => {
		const dir = mkdtempSync(join(tmpdir(), "deferred-delivery-"));
		const sessionFile = join(dir, "parent.jsonl");
		writeFileSync(sessionFile, "");
		const runId = "deferred-run-1";
		const parentSessionId = `parent-${runId}`;
		try {
			// Settle while inactive: the initial enqueue records ZERO attempts.
			try {
				await testApi.deliverBackgroundMessage(undefined, parentSessionId, resultMessage(runId), {
					sessionFile,
					expectedRunId: runId,
					graceMs: 100,
				});
				assert.fail("inactive delivery must throw");
			} catch (error) {
				assert.ok(testApi.isSessionRuntimeUnavailable(error));
				testApi.queuePendingDeliveryWithVerification(
					runId,
					parentSessionId,
					resultMessage(runId),
					error,
					{
						sessionFile,
						expectedRunId: runId,
					},
					0,
				);
			}
			const queued = testApi.pendingDeliveries.get(runId);
			assert.equal(queued.attempts, 0, "first deferral records zero ordinary attempts");
			assert.ok(queued.deferredSince !== undefined, "deferral interval started");

			// Pump while still inactive: deferred again, still no attempts consumed.
			await testApi.retryPendingDeliveries();
			const deferred = testApi.pendingDeliveries.get(runId);
			assert.ok(deferred, "still pending");
			assert.equal(deferred.attempts, 0, "deferral never consumes the send-attempt budget");
			assert.equal(deferred.exhausted ?? false, false);

			// Activate a bound session runtime that persists steers.
			const pi = fakeExtensionPi();
			pi.sendMessage = (msg: any) => {
				pi.sends.push(msg);
				appendFileSync(
					sessionFile,
					JSON.stringify({
						type: "custom_message",
						customType: msg.customType,
						content: msg.content,
						details: msg.details,
					}) + "\n",
				);
			};
			subagentsExtension(pi);
			pi.handlers.session_start({}, fakeCtx(parentSessionId, sessionFile));

			await testApi.retryPendingDeliveries();
			assert.equal(pi.sends.length, 1, "delivered exactly once after activation");
			assert.equal(testApi.pendingDeliveries.has(runId), false, "pending entry settled");
			assert.ok(testApi.deliveredRunIds.has(runId));
		} finally {
			testApi.pendingDeliveries.delete(runId);
			testApi.deliveredRunIds.delete(runId);
			testApi.inflightDelivery.delete(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks a continuously-deferred entry undeliverable once the deferral budget lapses", async () => {
		const runId = "deferral-budget-run";
		const parentSessionId = `parent-${runId}`;
		try {
			testApi.queuePendingDeliveryWithVerification(
				runId,
				parentSessionId,
				resultMessage(runId),
				new testApi.SessionRuntimeUnavailableError(parentSessionId),
				{ expectedRunId: runId },
				0,
			);
			const entry = testApi.pendingDeliveries.get(runId);
			// Simulate a continuous deferral that began before the budget window.
			entry.deferredSince = Date.now() - testApi.DEFERRED_DELIVERY_MAX_MS - 1;
			entry.nextRetryAt = Date.now();
			await testApi.retryPendingDeliveries();
			const after = testApi.pendingDeliveries.get(runId);
			assert.equal(after.exhausted, true, "deferral-exhausted → undeliverable");
			assert.match(after.lastError, /deferral budget exceeded/);
			assert.equal(after.attempts, 0, "deferral never consumed ordinary attempts");
		} finally {
			testApi.pendingDeliveries.delete(runId);
		}
	});

	it("renders deferred entries as awaiting the runtime, distinct from retries and undeliverable rows", () => {
		const deferred = {
			id: "d1",
			parentSessionId: "p",
			message: { details: { name: "deferred", agent: "a" } },
			attempts: 0,
			nextRetryAt: Date.now(),
			delivering: false,
			generation: 1,
			deferredSince: Date.now(),
		};
		const retrying = {
			id: "r1",
			parentSessionId: "p",
			message: { details: { name: "retrying", agent: "a" } },
			attempts: 1,
			nextRetryAt: Date.now(),
			delivering: false,
			generation: 1,
		};
		const exhausted = {
			id: "e1",
			parentSessionId: "p",
			message: { details: { name: "stuck", agent: "a" } },
			attempts: 8,
			nextRetryAt: Date.now(),
			delivering: false,
			generation: 1,
			exhausted: true,
		};
		const lines = testApi
			.renderSubagentWidgetLines([], 100, widgetTheme, [], [deferred, retrying, exhausted])
			.join("\n");
		assert.match(lines, /1 awaiting runtime/, "deferred counted separately");
		assert.match(lines, /1 delivery retrying/, "ordinary retries counted separately");
		assert.match(lines, /1 undeliverable/, "exhausted counted separately");
		const deferredRow = lines.split("\n").find((line) => line.includes("deferred"));
		assert.match(deferredRow, /awaiting runtime/, "deferred row is never rendered as retry 0");
		assert.doesNotMatch(deferredRow, /delivery retry 0/);
	});

	it("session_start re-drives only deferral-exhausted entries, never ordinary attempt exhaustion", () => {
		// Handler-level regression: the session_start reset must be selective. An
		// entry that exhausted the ordinary active-runtime send-attempt budget is
		// terminal — re-driving it on every reload would defeat bounded retry.
		const parentSessionId = "redrive-parent";
		const attemptExhausted: any = {
			id: "attempt-exhausted",
			parentSessionId,
			message: { details: { name: "stuck", agent: "a" } },
			attempts: 8,
			nextRetryAt: Date.now(),
			delivering: false,
			generation: 1,
			exhausted: true,
			exhaustionCause: "attempts",
		};
		const deferralExhausted: any = {
			id: "deferral-exhausted",
			parentSessionId,
			message: { details: { name: "deferred", agent: "a" } },
			attempts: 0,
			nextRetryAt: Date.now(),
			delivering: false,
			generation: 1,
			exhausted: true,
			exhaustionCause: "deferral",
			deferredSince: Date.now() - 3_700_000,
		};
		const otherParentExhausted: any = {
			id: "other-parent-exhausted",
			parentSessionId: "other-parent",
			message: { details: { name: "other", agent: "a" } },
			attempts: 8,
			nextRetryAt: Date.now(),
			delivering: false,
			generation: 1,
			exhausted: true,
			exhaustionCause: "deferral",
			deferredSince: Date.now() - 3_700_000,
		};
		testApi.pendingDeliveries.set(attemptExhausted.id, attemptExhausted);
		testApi.pendingDeliveries.set(deferralExhausted.id, deferralExhausted);
		testApi.pendingDeliveries.set(otherParentExhausted.id, otherParentExhausted);
		try {
			const pi = fakeExtensionPi();
			subagentsExtension(pi);
			pi.handlers.session_start({}, fakeCtx(parentSessionId));

			const attemptAfter = testApi.pendingDeliveries.get("attempt-exhausted");
			assert.equal(attemptAfter.exhausted, true, "ordinary attempt exhaustion stays terminal");
			assert.equal(attemptAfter.exhaustionCause, "attempts");
			assert.equal(attemptAfter.attempts, 8, "attempt budget not reopened");

			const deferralAfter = testApi.pendingDeliveries.get("deferral-exhausted");
			assert.equal(deferralAfter.exhausted, false, "deferral-exhausted entry is re-driven");
			assert.equal(deferralAfter.exhaustionCause, undefined);
			assert.equal(deferralAfter.deferredSince, undefined, "deferral interval reset before retry");

			const otherAfter = testApi.pendingDeliveries.get("other-parent-exhausted");
			assert.equal(otherAfter.exhausted, true, "another parent's terminal entry is not reset");
			assert.equal(otherAfter.exhaustionCause, "deferral");
			assert.ok(otherAfter.deferredSince !== undefined);

			const lines = testApi
				.renderSubagentWidgetLines(
					[],
					100,
					widgetTheme,
					[],
					[
						testApi.pendingDeliveries.get("attempt-exhausted"),
						testApi.pendingDeliveries.get("deferral-exhausted"),
					],
				)
				.join("\n");
			const stuckRow = lines.split("\n").find((line) => line.includes("stuck"));
			assert.match(stuckRow, /undeliverable/, "ordinary exhaustion still renders undeliverable");
			assert.doesNotMatch(lines, /2 undeliverable/, "re-driven deferral left the undeliverable count");
		} finally {
			testApi.pendingDeliveries.delete("attempt-exhausted");
			testApi.pendingDeliveries.delete("deferral-exhausted");
			testApi.pendingDeliveries.delete("other-parent-exhausted");
		}
	});
});

describe("final shutdown suppression", () => {
	it("suppresses inactive pending work so no later retry or wake sends", async () => {
		const dir = mkdtempSync(join(tmpdir(), "shutdown-suppress-"));
		const sessionFile = join(dir, "parent.jsonl");
		writeFileSync(sessionFile, "");
		const runId = "shutdown-run-1";
		const parentSessionId = `parent-${runId}`;
		try {
			const pi = fakeExtensionPi();
			subagentsExtension(pi);
			pi.handlers.session_start({}, fakeCtx(parentSessionId, sessionFile));
			// Track the parent as streaming so the pre-shutdown send is
			// stream-queued (no wake): the assertions below isolate POST-shutdown
			// behavior, where no further send or wake may ever occur.
			testApi.parentActivity.streaming = true;
			testApi.parentActivity.turnStartedAtMs = Date.now();
			// The stream-queued steer never drains; close the gap immediately after
			// the send so the acknowledgement declares loss instead of waiting out
			// the (by-design, one-hour) stream-aware re-verify cap.
			setTimeout(() => {
				testApi.parentActivity.streaming = false;
				testApi.parentActivity.turnStartedAtMs = 0;
			}, 20).unref();

			try {
				await testApi.deliverBackgroundMessage(undefined, parentSessionId, resultMessage(runId), {
					sessionFile,
					expectedRunId: runId,
					graceMs: 100,
				});
				assert.fail("nothing persists — the send must fail verification");
			} catch (error) {
				testApi.queuePendingDeliveryWithVerification(
					runId,
					parentSessionId,
					resultMessage(runId),
					error,
					{
						sessionFile,
						expectedRunId: runId,
					},
					1,
				);
			}
			assert.ok(testApi.pendingDeliveries.has(runId));

			// Final (non-reload) shutdown: pending delivery is suppressed and cleared.
			pi.handlers.session_shutdown({ reason: "quit" }, fakeCtx(parentSessionId, sessionFile));
			testApi.parentActivity.streaming = false;
			assert.equal(testApi.pendingDeliveries.size, 0, "final shutdown cleared pending work");
			assert.equal(testApi.resolveActiveCompletionRuntime(parentSessionId), undefined, "record deactivated");

			// No later send or wake may occur. A fresh delivery attempt defers
			// before the barrier with zero API calls, and a pump sweep finds no
			// pending rows — neither can touch the dead session's API.
			await assert.rejects(
				testApi.deliverBackgroundMessage(undefined, parentSessionId, resultMessage(runId), {
					sessionFile,
					expectedRunId: runId,
					graceMs: 100,
				}),
				(error: unknown) => testApi.isSessionRuntimeUnavailable(error),
			);
			await testApi.retryPendingDeliveries();
			assert.equal(pi.sends.length, 1, "only the pre-shutdown send happened");
			assert.equal(pi.wakes.length, 0, "no wake after suppression");
		} finally {
			testApi.pendingDeliveries.delete(runId);
			testApi.deliveredRunIds.delete(runId);
			testApi.inflightDelivery.delete(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
