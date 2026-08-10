import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";

const testApi = (subagentsModule as any).__test__;
const deliverBackgroundMessage: (
	pi: any,
	parentSessionId: string,
	message: any,
	options?: {
		sessionFile?: string;
		expectedRunId?: string;
		graceMs?: number;
		onWait?: (kind: string) => void;
	},
) => Promise<void> = testApi.deliverBackgroundMessage;
const WAKE_MESSAGE: string = testApi.WAKE_MESSAGE;
const deliveredRunIds: Set<string> = testApi.deliveredRunIds;
const inflightDelivery: Map<string, Promise<void>> = testApi.inflightDelivery;
const parentActivity: { streaming: boolean; turnStartedAtMs: number } = testApi.parentActivity;

// Delivery resolves the ACTIVE session-bound record at send time (never a
// captured factory API), so each fake parent API must be activated for its
// session before delivery. Reset in beforeEach: repeated in-process factory
// invocations must not leak a previous test's record into this suite.
function activateForSession(api: unknown, parentSessionId: string): void {
	testApi.activateCompletionRuntime(api, parentSessionId);
}

beforeEach(() => {
	testApi.resetActiveCompletionRuntime();
});

function resultEntry(runId: string): string {
	return `${JSON.stringify({
		type: "custom_message",
		customType: "subagent_result",
		content: "Sub-agent completed.",
		details: { id: runId, name: "reviewer", exitCode: 0 },
	})}\n`;
}

/** Fake parent API. `persist` controls whether the steer actually lands in the
 *  session log — i.e. whether verification can ever succeed. */
function fakePi(sessionFile: string, runId: string, persist: boolean) {
	const sends: unknown[] = [];
	const wakes: string[] = [];
	return {
		sends,
		wakes,
		api: {
			sendMessage(message: unknown, _options?: unknown) {
				sends.push(message);
				if (persist) writeFileSync(sessionFile, resultEntry(runId), { flag: "a" });
			},
			sendUserMessage(text: string, _options?: unknown) {
				wakes.push(text);
			},
		},
	};
}

describe("deliverBackgroundMessage — wake is not gated on acknowledgement", () => {
	it("wakes the parent even when acknowledgement fails, so a later turn can drain the steer", async () => {
		// Regression: the wake used to sit after `await ackPromise`. Against an idle
		// parent that deadlocked — verification could not succeed until a turn ran,
		// and the wake that starts that turn never fired. Observed in production as
		// a result reported "undeliverable" while the child's output was complete.
		const dir = mkdtempSync(join(tmpdir(), "delivery-wake-unacked-"));
		const sessionFile = join(dir, "parent.jsonl");
		const runId = "wake-before-ack-run";
		const parentSessionId = `parent-${runId}`;
		writeFileSync(sessionFile, "");
		const wasStreaming = parentActivity.streaming;
		parentActivity.streaming = false; // idle parent — the deadlocking case
		const { api, sends, wakes } = fakePi(sessionFile, runId, /* persist */ false);
		activateForSession(api, parentSessionId);
		try {
			await assert.rejects(
				deliverBackgroundMessage(
					api,
					parentSessionId,
					{ customType: "subagent_result" },
					{
						sessionFile,
						expectedRunId: runId,
						graceMs: 120,
					},
				),
				"delivery still reports failure when the steer never persists",
			);
			assert.equal(sends.length, 1, "the steer was sent exactly once");
			assert.deepEqual(wakes, [WAKE_MESSAGE], "the wake fired despite the failed acknowledgement");
		} finally {
			parentActivity.streaming = wasStreaming;
			deliveredRunIds.delete(runId);
			inflightDelivery.delete(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still wakes on the ordinary path where acknowledgement succeeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-wake-acked-"));
		const sessionFile = join(dir, "parent.jsonl");
		const runId = "wake-acked-run";
		const parentSessionId = `parent-${runId}`;
		writeFileSync(sessionFile, "");
		const wasStreaming = parentActivity.streaming;
		parentActivity.streaming = false;
		const { api, sends, wakes } = fakePi(sessionFile, runId, /* persist */ true);
		activateForSession(api, parentSessionId);
		try {
			await deliverBackgroundMessage(
				api,
				parentSessionId,
				{ customType: "subagent_result" },
				{
					sessionFile,
					expectedRunId: runId,
					graceMs: 2_000,
				},
			);
			assert.equal(sends.length, 1, "sent once");
			assert.deepEqual(wakes, [WAKE_MESSAGE], "wake fired");
			assert.ok(deliveredRunIds.has(runId), "marked delivered after verified persistence");
		} finally {
			parentActivity.streaming = wasStreaming;
			deliveredRunIds.delete(runId);
			inflightDelivery.delete(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("deliverBackgroundMessage — a failing wait observer cannot break delivery", () => {
	it("does not resend when onWait throws and the steer has not yet landed", async () => {
		// Regression: onWait ran after `sendMessage` but before the in-flight
		// acknowledgement was registered, and was not guarded. A throwing observer
		// propagated out of the barrier's send callback, which retries up to three
		// times — so the steer was re-sent while dedup-before-send could not see the
		// first copy (it has not landed in the log yet). Pre-fix this records three
		// sends; the fix reports the phase last and swallows observer failures.
		const dir = mkdtempSync(join(tmpdir(), "delivery-onwait-throws-"));
		const sessionFile = join(dir, "parent.jsonl");
		const runId = "onwait-throws-run";
		const parentSessionId = `parent-${runId}`;
		writeFileSync(sessionFile, "");
		const wasStreaming = parentActivity.streaming;
		parentActivity.streaming = false;
		// persist:false — an unlanded steer, the case log-dedup cannot cover.
		const { api, sends } = fakePi(sessionFile, runId, /* persist */ false);
		activateForSession(api, parentSessionId);
		let observed = 0;
		try {
			await assert.rejects(
				deliverBackgroundMessage(
					api,
					parentSessionId,
					{ customType: "subagent_result" },
					{
						sessionFile,
						expectedRunId: runId,
						graceMs: 120,
						onWait: () => {
							observed += 1;
							throw new Error("widget render exploded");
						},
					},
				),
				"still reports failure — the steer genuinely never persisted",
			);
			assert.ok(observed > 0, "the observer really was invoked");
			assert.equal(sends.length, 1, "exactly one send — a throwing observer caused no resend");
		} finally {
			parentActivity.streaming = wasStreaming;
			deliveredRunIds.delete(runId);
			inflightDelivery.delete(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("completes normally when onWait throws on a delivery that does persist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-onwait-persisted-"));
		const sessionFile = join(dir, "parent.jsonl");
		const runId = "onwait-persisted-run";
		const parentSessionId = `parent-${runId}`;
		writeFileSync(sessionFile, "");
		const wasStreaming = parentActivity.streaming;
		parentActivity.streaming = false;
		const { api, sends } = fakePi(sessionFile, runId, /* persist */ true);
		activateForSession(api, parentSessionId);
		try {
			await deliverBackgroundMessage(
				api,
				parentSessionId,
				{ customType: "subagent_result" },
				{
					sessionFile,
					expectedRunId: runId,
					graceMs: 2_000,
					onWait: () => {
						throw new Error("widget render exploded");
					},
				},
			);
			assert.equal(sends.length, 1, "sent once");
			assert.ok(deliveredRunIds.has(runId), "delivery completed normally");
		} finally {
			parentActivity.streaming = wasStreaming;
			deliveredRunIds.delete(runId);
			inflightDelivery.delete(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports the verifying phase for an idle parent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-onwait-kind-"));
		const sessionFile = join(dir, "parent.jsonl");
		const runId = "onwait-kind-run";
		const parentSessionId = `parent-${runId}`;
		writeFileSync(sessionFile, "");
		const wasStreaming = parentActivity.streaming;
		parentActivity.streaming = false;
		const { api } = fakePi(sessionFile, runId, /* persist */ true);
		activateForSession(api, parentSessionId);
		const kinds: string[] = [];
		try {
			await deliverBackgroundMessage(
				api,
				parentSessionId,
				{ customType: "subagent_result" },
				{
					sessionFile,
					expectedRunId: runId,
					graceMs: 2_000,
					onWait: (kind) => kinds.push(kind),
				},
			);
			assert.deepEqual(kinds, ["verifying"], "idle parent reports the verifying phase");
		} finally {
			parentActivity.streaming = wasStreaming;
			deliveredRunIds.delete(runId);
			inflightDelivery.delete(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("deliverBackgroundMessage — mid-drain runtime loss cannot strand an accepted sibling's wake", () => {
	it("wakes from the last accepted send when the positional-slot callback fails its runtime check", async () => {
		// Regression: the barrier assigns its wake slot positionally to the final
		// queued callback. If the session-bound runtime disappears mid-drain, that
		// final callback fails its defensive re-check — and before the fix, the
		// earlier accepted sibling (sent with wake=false) never fired the wake,
		// so its idle-parent steer could sit unpersisted. Delivery now wakes from
		// ANY accepted send through the per-session deduplicated wake path.
		const dir = mkdtempSync(join(tmpdir(), "delivery-mid-drain-"));
		const sessionFile = join(dir, "parent.jsonl");
		const runA = "mid-drain-a";
		const runB = "mid-drain-b";
		const parentSessionId = `parent-${runA}`;
		writeFileSync(sessionFile, "");
		const wasStreaming = parentActivity.streaming;
		parentActivity.streaming = false; // idle parent — a wake is required
		const sends: string[] = [];
		const wakes: string[] = [];
		const api = {
			sendMessage(message: any, _options?: unknown) {
				const id = message.details?.id ?? "?";
				sends.push(id);
				writeFileSync(
					sessionFile,
					`${JSON.stringify({
						type: "custom_message",
						customType: message.customType,
						content: message.content,
						details: message.details,
					})}\n`,
					{ flag: "a" },
				);
				// Let A's immediate wake run first, then make B's defensive runtime
				// check fail on the next microtask (mid-drain deactivation).
				if (id === runA) queueMicrotask(() => testApi.resetActiveCompletionRuntime());
			},
			sendUserMessage(text: string, _options?: unknown) {
				wakes.push(text);
			},
		};
		// Foreground lease holds both deliveries until both are queued, so they
		// share one drain batch: A is not the last (wake=false), B is (wake=true).
		const barrier = testApi.getForegroundDeliveryBarrier(parentSessionId);
		const lease = barrier.enter("mid-drain-fg");
		try {
			activateForSession(api, parentSessionId);
			const deliveryA = deliverBackgroundMessage(
				api,
				parentSessionId,
				{
					customType: "subagent_result",
					content: "done",
					display: true,
					details: { id: runA, name: "a", task: "x", agent: "t" },
				},
				{ sessionFile, expectedRunId: runA, graceMs: 2_000 },
			);
			const deliveryB = deliverBackgroundMessage(
				api,
				parentSessionId,
				{
					customType: "subagent_result",
					content: "done",
					display: true,
					details: { id: runB, name: "b", task: "x", agent: "t" },
				},
				{ sessionFile, expectedRunId: runB, graceMs: 2_000 },
			);

			// Both callbacks are queued; B runs AFTER A in the drain. A's send
			// schedules the runtime deactivation after the immediate wake, but before
			// the next callback's defensive check.
			lease.release();

			await deliveryA;
			await assert.rejects(deliveryB, (error: unknown) => testApi.isSessionRuntimeUnavailable(error));

			assert.deepEqual(sends, [runA], "only A was sent before the runtime vanished");
			assert.deepEqual(wakes, [WAKE_MESSAGE], "the accepted sibling still woke the idle parent");
			assert.ok(deliveredRunIds.has(runA), "A's delivery completed");
		} finally {
			parentActivity.streaming = wasStreaming;
			deliveredRunIds.delete(runA);
			deliveredRunIds.delete(runB);
			inflightDelivery.delete(runA);
			inflightDelivery.delete(runB);
			testApi.resetActiveCompletionRuntime();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
