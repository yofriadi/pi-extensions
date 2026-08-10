import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";
import { createLifecycle, markCompletionDetected } from "../src/lifecycle.ts";
import { createPlainWidgetTheme } from "./widget-theme.ts";

const testApi = (subagentsModule as any).__test__;

/**
 * A settled run awaiting handoff and a genuinely wedged one both rendered as
 * `finalizing…`, and every retry state — including exhausted ones that nothing
 * is retrying — collapsed into one "delivery pending" tally. These assert the
 * states are told apart.
 */
describe("widget — delivery wait vs delivery failure", () => {
	const theme = createPlainWidgetTheme();
	const settledRun = (deliveryWait?: { kind: string; since: number }) => ({
		id: "run-1",
		name: "Worker",
		task: "",
		surface: "s1",
		startTime: 5_000,
		sessionFile: "sess1",
		lifecycle: markCompletionDetected(createLifecycle(5_000), { reason: "done", exitCode: 0 }, 20_000),
		...(deliveryWait ? { deliveryWait } : {}),
	});

	const withFrozenNow = <T>(now: number, body: () => T): T => {
		const originalNow = Date.now;
		Date.now = () => now;
		try {
			return body();
		} finally {
			Date.now = originalNow;
		}
	};

	it("names the reason a settled run is still waiting instead of 'finalizing…'", () => {
		const cases: Array<[string, RegExp]> = [
			["barrier", /held · foreground busy/],
			["turn-boundary", /awaiting turn boundary/],
			["verifying", /confirming delivery/],
		];
		for (const [kind, expected] of cases) {
			const lines = withFrozenNow(30_000, () =>
				testApi.renderSubagentWidgetLines([settledRun({ kind, since: 25_000 })], 100, theme),
			);
			const row = lines.join("\n");
			assert.match(row, expected, `${kind} must render a distinguishable label`);
			assert.doesNotMatch(row, /finalizing/, `${kind} must not fall back to finalizing…`);
			assert.match(row, /5s/, "must show how long THIS wait has lasted");
		}
	});

	it("still renders finalizing… when no wait reason has been reported", () => {
		const lines = withFrozenNow(30_000, () => testApi.renderSubagentWidgetLines([settledRun()], 100, theme));
		assert.match(lines.join("\n"), /finalizing/);
	});

	it("times the wait from the phase change, not from run start", () => {
		// A run started at 5s that began waiting at 29s has waited 1s, not 25s.
		const lines = withFrozenNow(30_000, () =>
			testApi.renderSubagentWidgetLines([settledRun({ kind: "turn-boundary", since: 29_000 })], 100, theme),
		);
		assert.match(lines.join("\n"), /awaiting turn boundary 1s/);
	});

	it("separates actively-retrying deliveries from undeliverable ones", () => {
		const lines = testApi.renderSubagentWidgetLines(
			[],
			120,
			theme,
			[],
			[
				{
					id: "retrying-1",
					parentSessionId: "p",
					message: { details: { name: "Alpha", agent: "worker" } },
					attempts: 2,
					nextRetryAt: 0,
					delivering: false,
					generation: 1,
					lastError: "Delivery verification failed",
				},
				{
					id: "dead-1",
					parentSessionId: "p",
					message: { details: { name: "Beta", agent: "worker" } },
					attempts: 8,
					nextRetryAt: 0,
					delivering: false,
					generation: 1,
					exhausted: true,
					lastError: "Delivery verification failed",
				},
			],
		);
		const text = lines.join("\n");
		assert.match(lines[0], /1 delivery retrying/, "in-flight retries counted separately");
		assert.match(lines[0], /1 undeliverable/, "exhausted entries must not hide in the retry tally");
		assert.doesNotMatch(lines[0], /2 delivery pending/, "the merged tally must be gone");
		assert.match(text, /Alpha.*delivery retry 2/s);
		// "retry 8" implies work in progress; nothing is retrying an exhausted entry.
		assert.match(text, /Beta.*undeliverable after 8/s);
	});

	it("keeps surfacing the last error on both retrying and undeliverable rows", () => {
		const entry = (id: string, exhausted: boolean) => ({
			id,
			parentSessionId: "p",
			message: { details: { name: id, agent: "worker" } },
			attempts: exhausted ? 8 : 1,
			nextRetryAt: 0,
			delivering: false,
			generation: 1,
			...(exhausted ? { exhausted: true } : {}),
			lastError: "not persisted within 8000ms",
		});
		const lines = testApi.renderSubagentWidgetLines(
			[],
			160,
			theme,
			[],
			[entry("live", false), entry("dead", true)],
		);
		const matching = lines.filter((l: string) => l.includes("not persisted within 8000ms"));
		assert.equal(matching.length, 2, "both rows must still say WHY delivery failed");
	});
});
