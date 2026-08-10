import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_COMPLETION_TIMEOUT_MS, formatTimeoutBudget, waitForCompletion } from "../src/completion.ts";

const noTail = async () => "";

describe("waitForCompletion — bounded watch deadline", () => {
	it("settles as an explicit timeout instead of watching forever", async () => {
		const controller = new AbortController();
		const result = await waitForCompletion(controller.signal, {
			intervalMs: 5,
			readTerminalTail: noTail,
			timeoutMs: 40,
		});
		// A distinct reason, NOT "error": an expired watch is an admission that we
		// stopped observing, not a reported child failure. Presentation depends on
		// telling those apart.
		assert.equal(result.reason, "timeout");
		assert.equal(result.exitCode, 1);
		assert.match(
			result.errorMessage ?? "",
			/no completion evidence within/,
			"timeout result should explain that watching stopped",
		);
		assert.doesNotMatch(result.errorMessage ?? "", /within 0s/, "a sub-second budget must not render as 0s");
	});

	it("prefers real completion evidence that races in at the deadline", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-timeout-race-"));
		const sessionFile = join(dir, "child.jsonl");
		const runId = "race-run-1";
		// Publish the sidecar after the deadline fires but inside the bounded
		// artifact grace window, so the raced-evidence path is the one exercised.
		const timer = setTimeout(() => {
			writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done", runId }));
		}, 70);
		try {
			const controller = new AbortController();
			const result = await waitForCompletion(controller.signal, {
				intervalMs: 5,
				readTerminalTail: noTail,
				sessionFile,
				expectedRunId: runId,
				timeoutMs: 40,
				paneDisappearanceGraceMs: 500,
			});
			assert.equal(result.reason, "done", "real evidence must win over a synthetic timeout");
			assert.equal(result.exitCode, 0);
			assert.equal(result.runId, runId);
		} finally {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats timeoutMs=0 as an explicitly disabled cap", async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 60);
		try {
			await assert.rejects(
				waitForCompletion(controller.signal, {
					intervalMs: 5,
					readTerminalTail: noTail,
					timeoutMs: 0,
				}),
				/Aborted while waiting for subagent to finish/,
				"with the cap disabled the watcher must keep waiting until aborted",
			);
		} finally {
			clearTimeout(timer);
		}
	});

	it("exposes a finite default cap so callers cannot wait forever by omission", () => {
		assert.ok(Number.isFinite(DEFAULT_COMPLETION_TIMEOUT_MS));
		assert.ok(DEFAULT_COMPLETION_TIMEOUT_MS > 60_000, "default must be generous enough for real subagent work");
	});

	it("never reports 'no evidence' for a sentinel written near the deadline", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-timeout-sentinel-"));
		const sentinelFile = join(dir, "done.sentinel");
		// Land the sentinel between the last pre-deadline poll and the deadline
		// check, so evidence must not be discarded in favour of a synthetic error.
		const timer = setTimeout(() => writeFileSync(sentinelFile, ""), 110);
		try {
			const controller = new AbortController();
			const result = await waitForCompletion(controller.signal, {
				intervalMs: 50,
				readTerminalTail: noTail,
				sentinelFile,
				timeoutMs: 120,
			});
			assert.equal(result.reason, "sentinel", "sentinel evidence must survive the deadline");
			assert.equal(result.exitCode, 0);
		} finally {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("honours a terminal-tail sentinel at the deadline (the production channel)", async () => {
		// watchSubagent passes no sentinelFile, so the terminal tail is the only
		// sentinel channel that actually runs in production. A deadline sweep that
		// ignored it would falsely time out a run that had already printed its
		// completion sentinel.
		let reads = 0;
		const controller = new AbortController();
		const result = await waitForCompletion(controller.signal, {
			intervalMs: 500, // no second poll before the deadline
			timeoutMs: 60,
			readTerminalTail: async () => {
				reads += 1;
				// Silent until the deadline sweep asks.
				return reads >= 2 ? "__SUBAGENT_DONE_7__" : "";
			},
		});
		assert.equal(result.reason, "sentinel", "tail sentinel must be swept at the deadline");
		assert.equal(result.exitCode, 7, "the tail's exit code must be preserved");
	});

	it("does not hang when the tail probe never resolves at the deadline", async () => {
		// A wedged herdr subprocess must not convert a bounded watch into an
		// unbounded one via the deadline sweep's own probe.
		const controller = new AbortController();
		const started = Date.now();
		const result = await waitForCompletion(controller.signal, {
			intervalMs: 5,
			timeoutMs: 30,
			readTerminalTail: () => new Promise<string>(() => {}), // never settles
			probeTimeoutMs: 60,
		});
		assert.equal(result.reason, "timeout");
		assert.ok(Date.now() - started < 5_000, "the deadline sweep must abandon a hung probe rather than wait on it");
	});

	it("keeps watching when the pane probe hangs, instead of stalling the loop", async () => {
		// A hung inspectPane previously blocked pane-missing detection. It must be
		// treated as "no reading" so the loop continues to its deadline.
		const inspections: string[] = [];
		const controller = new AbortController();
		const result = await waitForCompletion(controller.signal, {
			intervalMs: 5,
			timeoutMs: 120,
			readTerminalTail: noTail,
			probeTimeoutMs: 20,
			inspectPane: () => new Promise(() => {}), // never settles
			onPaneInspection: (inspection) => {
				inspections.push(inspection.kind);
			},
		});
		assert.equal(result.reason, "timeout", "a hung pane probe must not strand the watcher");
		assert.ok(inspections.length > 0, "the hung probe was reported as an observation");
		assert.ok(
			inspections.every((kind) => kind === "unavailable"),
			"a hung probe is 'unavailable', never 'missing' — it is not evidence the pane vanished",
		);
	});
});

describe("formatTimeoutBudget", () => {
	it("renders human budgets without collapsing small ones to zero", () => {
		assert.equal(formatTimeoutBudget(DEFAULT_COMPLETION_TIMEOUT_MS), "4h");
		assert.equal(formatTimeoutBudget(3_600_000), "1h");
		assert.equal(formatTimeoutBudget(5_400_000), "1.5h");
		assert.equal(formatTimeoutBudget(60_000), "1m");
		assert.equal(formatTimeoutBudget(45_000), "45s");
		assert.equal(formatTimeoutBudget(1_000), "1s");
		// Sub-second budgets are used by tests and deliberately tiny caps; "0s"
		// would make the resulting message nonsensical.
		assert.equal(formatTimeoutBudget(40), "40ms");
		assert.equal(formatTimeoutBudget(999), "999ms");
	});
});
