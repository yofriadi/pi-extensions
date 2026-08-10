import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";

const testApi = (subagentsModule as any).__test__;
const verifyDeliveryPersisted: (
	sessionFile: string,
	expectedRunId: string,
	customType: string,
	options?: { graceMs?: number; intervalMs?: number },
) => Promise<void> = testApi.verifyDeliveryPersisted;
const deliveryEntryExists: (sessionFile: string, expectedRunId: string, customType: string) => Promise<boolean> =
	testApi.deliveryEntryExists;

describe("verifyDeliveryPersisted — delivery verification guard", () => {
	it("resolves when the expected custom message is present in the session log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-verify-ok-"));
		const sessionFile = join(dir, "parent.jsonl");
		try {
			const runId = "abc123";
			const entry = JSON.stringify({
				type: "custom_message",
				customType: "subagent_result",
				content: "Sub-agent completed.",
				details: { id: runId, name: "test-agent", exitCode: 0 },
			});
			writeFileSync(sessionFile, `${entry}\n`);
			await verifyDeliveryPersisted(sessionFile, runId, "subagent_result", {
				graceMs: 200,
				intervalMs: 10,
			});
			// Should resolve without throwing.
			assert.ok(true, "verification resolved — message found");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("matches records nested under .message (pi session-log format)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-verify-nested-"));
		const sessionFile = join(dir, "parent.jsonl");
		try {
			const runId = "nested-run-456";
			// Some pi versions nest custom message fields under .message.
			const entry = JSON.stringify({
				type: "message",
				message: {
					type: "custom_message",
					customType: "subagent_result",
					content: "Sub-agent completed.",
					details: { id: runId, name: "test-agent", exitCode: 0 },
				},
			});
			writeFileSync(sessionFile, `${entry}\n`);
			await verifyDeliveryPersisted(sessionFile, runId, "subagent_result", {
				graceMs: 200,
				intervalMs: 10,
			});
			assert.ok(true, "verification resolved for nested record");
			// Also verify deliveryEntryExists works for nested records.
			assert.ok(
				await deliveryEntryExists(sessionFile, runId, "subagent_result"),
				"deliveryEntryExists finds nested record",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects when the expected run ID is not in the session log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-verify-missing-"));
		const sessionFile = join(dir, "parent.jsonl");
		try {
			// Log has a different run ID, not the one we expect.
			const entry = JSON.stringify({
				type: "custom_message",
				customType: "subagent_result",
				content: "Sub-agent completed.",
				details: { id: "different-id", name: "test-agent", exitCode: 0 },
			});
			writeFileSync(sessionFile, `${entry}\n`);
			await assert.rejects(
				verifyDeliveryPersisted(sessionFile, "abc123", "subagent_result", {
					graceMs: 100,
					intervalMs: 10,
				}),
				/Delivery verification failed/,
				"should reject when run ID is not found",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects when the session file does not exist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-verify-nofile-"));
		const sessionFile = join(dir, "nonexistent.jsonl");
		try {
			await assert.rejects(
				verifyDeliveryPersisted(sessionFile, "abc123", "subagent_result", {
					graceMs: 100,
					intervalMs: 10,
				}),
				/Delivery verification failed/,
				"should reject when session file is absent",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not satisfy verification with two unrelated entries (correct customType but wrong ID)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-verify-split-"));
		const sessionFile = join(dir, "parent.jsonl");
		try {
			// One entry has the right customType but wrong ID; another has the right ID
			// but wrong customType. Neither alone satisfies the check.
			const entries = [
				JSON.stringify({
					type: "custom_message",
					customType: "subagent_result",
					details: { id: "wrong-id", exitCode: 0 },
				}),
				JSON.stringify({
					type: "custom_message",
					customType: "subagent_status",
					details: { id: "abc123", lines: 1 },
				}),
			].join("\n");
			writeFileSync(sessionFile, `${entries}\n`);
			await assert.rejects(
				verifyDeliveryPersisted(sessionFile, "abc123", "subagent_result", {
					graceMs: 100,
					intervalMs: 10,
				}),
				/Delivery verification failed/,
				"split entries must not satisfy verification",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("finds the entry when it appears later in the log (within grace window)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-verify-delayed-"));
		const sessionFile = join(dir, "parent.jsonl");
		try {
			// Start with an empty-ish log; write the expected entry after a short delay.
			writeFileSync(sessionFile, `${JSON.stringify({ type: "message", role: "user" })}\n`);
			const runId = "delayed-run";
			setTimeout(() => {
				const entry = JSON.stringify({
					type: "custom_message",
					customType: "subagent_result",
					details: { id: runId, exitCode: 0 },
				});
				writeFileSync(sessionFile, `${entry}\n`, { flag: "a" });
			}, 50);
			await verifyDeliveryPersisted(sessionFile, runId, "subagent_result", {
				graceMs: 500,
				intervalMs: 20,
			});
			assert.ok(true, "verification resolved after delayed write");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not match when nested candidate has right customType but wrong ID and outer has wrong customType but right ID", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-verify-split-nested-"));
		const sessionFile = join(dir, "parent.jsonl");
		try {
			// A single record where .message.customType matches but .message.details.id
			// is wrong, while the outer record has the right id but wrong customType.
			// The normalization must check each candidate independently — neither
			// candidate alone satisfies both customType + id.
			const entry = JSON.stringify({
				type: "message",
				customType: "subagent_status", // outer: wrong customType
				details: { id: "abc123", lines: 1 }, // outer: right ID
				message: {
					type: "custom_message",
					customType: "subagent_result", // nested: right customType
					details: { id: "wrong-id", exitCode: 0 }, // nested: wrong ID
				},
			});
			writeFileSync(sessionFile, `${entry}\n`);
			await assert.rejects(
				verifyDeliveryPersisted(sessionFile, "abc123", "subagent_result", {
					graceMs: 100,
					intervalMs: 10,
				}),
				/Delivery verification failed/,
				"split nested/outer candidates must not satisfy verification",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const acknowledgeDelivery: (
	sessionFile: string,
	runId: string,
	customType: string,
	options: { graceMs: number; queuedIntoStream: boolean; streamWaitMs?: number },
) => Promise<void> = testApi.acknowledgeDelivery;
const parentActivity: { streaming: boolean; turnStartedAtMs: number } = testApi.parentActivity;

describe("acknowledgeDelivery — bounded stream re-verify", () => {
	it("gives up instead of looping forever when a streaming parent never settles", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-ack-cap-"));
		const sessionFile = join(dir, "parent.jsonl");
		// Empty log: the steer was dropped, so verification can never succeed.
		writeFileSync(sessionFile, "");
		const wasStreaming = parentActivity.streaming;
		// A parent stuck mid-turn that never emits agent_settled — the condition
		// that made the uncapped loop hang the run in `finalizing…` forever.
		parentActivity.streaming = true;
		const startedAt = Date.now();
		try {
			await assert.rejects(
				acknowledgeDelivery(sessionFile, "dropped-run", "subagent_result", {
					graceMs: 30,
					queuedIntoStream: true,
					streamWaitMs: 60,
				}),
				/Delivery verification failed/,
				"must reject so the bounded retry pump takes over",
			);
			assert.ok(Date.now() - startedAt < 5_000, "must respect the stream wait cap rather than hang");
		} finally {
			parentActivity.streaming = wasStreaming;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves as soon as a queued steer drains, without waiting out the cap", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delivery-ack-drain-"));
		const sessionFile = join(dir, "parent.jsonl");
		const runId = "drained-run";
		writeFileSync(sessionFile, "");
		const wasStreaming = parentActivity.streaming;
		parentActivity.streaming = true;
		// Simulate the running loop draining the steer at a turn boundary.
		const timer = setTimeout(() => {
			writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "custom_message",
					customType: "subagent_result",
					content: "done",
					details: { id: runId },
				})}\n`,
			);
		}, 80);
		try {
			await acknowledgeDelivery(sessionFile, runId, "subagent_result", {
				graceMs: 40,
				queuedIntoStream: true,
				streamWaitMs: 5_000,
			});
			assert.ok(true, "acknowledged once the entry appeared");
		} finally {
			clearTimeout(timer);
			parentActivity.streaming = wasStreaming;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
