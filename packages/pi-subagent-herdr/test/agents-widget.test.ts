import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type SubagentActivityState, writeSubagentActivityFile } from "../src/activity.ts";
import * as subagentsModule from "../src/index.ts";
import {
	createLifecycle,
	markCompleted,
	markCompletionDetected,
	markDelivery,
	markFailed,
	markInterruptRequested,
	observePaneInspection,
} from "../src/lifecycle.ts";
import { createPlainWidgetTheme, createTaggedWidgetTheme } from "./widget-theme.ts";

const testApi = (subagentsModule as any).__test__;
const plainTheme = createPlainWidgetTheme();
const taggedTheme = createTaggedWidgetTheme();

function withNow<T>(now: number, body: () => T): T {
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		return body();
	} finally {
		Date.now = originalNow;
	}
}

function workingLifecycle(startTime = 1_000, activeAt = 2_000) {
	return observePaneInspection(
		createLifecycle(startTime),
		{ kind: "present", observedAt: activeAt, agentStatus: "working" },
		activeAt,
	);
}

function baseRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "run-1",
		name: "reviewer",
		agent: "reviewer",
		task: "",
		surface: "pane-1",
		startTime: 1_000,
		sessionFile: "/tmp/run-1.jsonl",
		admissionClass: "background",
		runtimePlan: undefined,
		lifecycle: workingLifecycle(),
		...overrides,
	};
}

function telemetry(overrides: Partial<SubagentActivityState> = {}): SubagentActivityState {
	return {
		version: 1,
		runningChildId: "run-1",
		createdAt: 1_000,
		updatedAt: 9_000,
		sequence: 9,
		latestEvent: "tool_execution_end",
		phase: "active",
		agentActive: true,
		turnActive: true,
		providerActive: false,
		toolActive: false,
		turnIndex: 5,
		toolCount: 5,
		contextTokens: 33_800,
		contextWindow: 54_516,
		contextPercent: 62,
		compactionCount: 2,
		...overrides,
	};
}

function render(
	agents: unknown[] = [],
	width = 120,
	queued: unknown[] = [],
	pending: unknown[] = [],
	sticky: unknown[] = [],
) {
	return testApi.renderSubagentWidgetLines(agents, width, plainTheme, queued, pending, sticky);
}

afterEach(() => {
	testApi.stickyTerminalRuns.clear();
	testApi.runningSubagents.clear();
	testApi.queuedSubagents.clear();
	testApi.pendingDeliveries.clear();
	testApi.setLatestWidgetContext(undefined);
});

describe("agents dashboard rows", () => {
	it("formats widget durations adaptively", () => {
		assert.equal(testApi.formatWidgetDuration(12_300), "12.3s");
		assert.equal(testApi.formatWidgetDuration(137_000), "2m17s");
		assert.equal(testApi.formatWidgetDuration(3_840_000), "1h04m");
	});

	it("renders active rows as two lines with a pure clock-indexed spinner and run label", () => {
		const lines = withNow(10_000, () =>
			render([
				baseRun({
					id: "a1b2",
					name: "adversarial review",
					agent: "plan-reviewer",
					activity: telemetry({ runningChildId: "a1b2" }),
				}),
			]),
		);
		assert.match(lines[0], /●.*Subagents.*1 active/);
		assert.match(lines[1], /⠋ Plan Reviewer · \[a1b2\] · background · 9s/);
		assert.match(lines[2], /⎿ {2}adversarial review · ↻5 · ⚙5 · ◈33\.8k \(62% · ⇊2\)/);
	});

	it("shows compact widget-only run IDs and expands colliding visible prefixes", () => {
		const single = withNow(10_000, () =>
			render([
				baseRun({
					id: "e7e7be5cd18d9542c82cf7ccb79d23eb",
				}),
			]),
		);
		assert.match(single[1], /\[e7e7be5c\]/);
		assert.doesNotMatch(single[1], /e7e7be5cd18d9542c82cf7ccb79d23eb/);

		const colliding = withNow(10_000, () =>
			render([
				baseRun({ id: "e7e7be5c111111111111111111111111" }),
				baseRun({ id: "e7e7be5c222222222222222222222222" }),
			]),
		).join("\n");
		assert.match(colliding, /\[e7e7be5c1\]/);
		assert.match(colliding, /\[e7e7be5c2\]/);
	});

	it("uses static glyphs and state-leading activity lines for blocked, waiting, interrupted, and stalled", () => {
		let blocked = workingLifecycle();
		blocked = observePaneInspection(blocked, { kind: "present", observedAt: 3_000, agentStatus: "blocked" }, 3_000);
		let waiting = workingLifecycle();
		waiting = observePaneInspection(waiting, { kind: "present", observedAt: 4_000, agentStatus: "idle" }, 4_000);
		const interrupted = markInterruptRequested(workingLifecycle(), 5_000);
		const stalled = {
			...workingLifecycle(),
			pane: { kind: "read-error" as const, firstFailedAt: 2_000, lastFailedAt: 2_000, consecutiveFailures: 1 },
		};

		const lines = withNow(70_000, () =>
			render([
				baseRun({ id: "blocked", lifecycle: blocked }),
				baseRun({ id: "waiting", lifecycle: waiting }),
				baseRun({ id: "interrupted", lifecycle: interrupted }),
				baseRun({ id: "stalled", lifecycle: stalled }),
			]),
		);
		const text = lines.join("\n");
		assert.match(text, /◆ Reviewer · \[blocked\]/);
		assert.match(text, /blocked 1m07s/);
		assert.match(text, /◷ Reviewer · \[waiting\]/);
		assert.match(text, /waiting 1m06s/);
		assert.match(text, /■ Reviewer · \[interrupted\]/);
		assert.match(text, /interrupted 1m05s/);
		assert.match(text, /⚠ Reviewer · \[stalled\]/);
		assert.match(text, /stalled 1m08s/);
		assert.doesNotMatch(text, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Reviewer · \[(blocked|waiting|interrupted|stalled)\]/);
	});

	it("omits a fabricated run label and starts the activity line with telemetry", () => {
		const lines = withNow(10_000, () => render([baseRun({ activity: telemetry() })]));
		assert.match(lines[2], /⎿ {2}↻5 · ⚙5/);
		assert.doesNotMatch(lines[2], /⎿ {2}reviewer/i);
	});

	it("renders delivery wait reasons in the two-line family", () => {
		const lifecycle = markCompletionDetected(createLifecycle(1_000), { reason: "done", exitCode: 0 }, 8_000);
		const lines = withNow(10_000, () =>
			render([
				baseRun({
					lifecycle,
					deliveryWait: { kind: "barrier", since: 9_000 },
					activity: telemetry(),
				}),
			]),
		);
		assert.match(lines[1], /7s/);
		assert.match(lines[2], /held · foreground busy 1s · ↻5/);
	});

	it("caps queued rows at three, adds overflow, and preserves warning delivery rows", () => {
		const queued = Array.from({ length: 5 }, (_, index) => ({
			id: `q${index + 1}`,
			name: "Review",
			agent: "reviewer",
			admissionClass: "background",
			queuedAt: 0,
			cancel() {
				return true;
			},
		}));
		const pending = [
			{
				id: "delivery-1",
				parentSessionId: "parent",
				message: { details: { name: "Review", agent: "reviewer" } },
				attempts: 2,
				nextRetryAt: 0,
				delivering: false,
				generation: 1,
				lastError: "\x1b[31mnot persisted\x1b[0m\nretry",
			},
		];
		const lines = render([], 120, queued, pending);
		const text = lines.join("\n");
		assert.equal(lines.filter((line: string) => line.includes("· queued")).length, 3);
		assert.match(text, /\+2 more queued/);
		assert.match(text, /⚠ Review \[delivery-1\] · delivery retry 2 · not persisted retry/);
		// eslint-disable-next-line no-control-regex -- verifies hostile terminal escapes were stripped
		assert.doesNotMatch(text, /\x1b\[31m|\nretry/);
	});

	it("colors utilization tiers through theme tokens, derives absent percent, and dims compactions", () => {
		const runs = [
			baseRun({ id: "low", activity: telemetry({ runningChildId: "low", contextPercent: 62 }) }),
			baseRun({ id: "warn", activity: telemetry({ runningChildId: "warn", contextPercent: 84 }) }),
			baseRun({ id: "high", activity: telemetry({ runningChildId: "high", contextPercent: 91 }) }),
			baseRun({
				id: "derived",
				activity: telemetry({
					runningChildId: "derived",
					contextTokens: 75_000,
					contextWindow: 100_000,
					contextPercent: undefined,
				}),
			}),
			baseRun({ id: "missing", activity: telemetry({ runningChildId: "missing", contextPercent: null }) }),
		];
		const lines = withNow(10_000, () => testApi.renderSubagentWidgetLines(runs, 160, taggedTheme));
		const text = lines.join("\n");
		assert.match(text, /tier:dim[^\n]*62%/);
		assert.match(text, /tier:warning[^\n]*84%/);
		assert.match(text, /tier:error[^\n]*91%/);
		assert.match(text, /tier:warning[^\n]*75%/);
		assert.match(text, /tier:dim[^\n]*⇊2/);
		const missingIdentity = lines.findIndex((line: string) => line.includes("[missing]"));
		assert.ok(missingIdentity >= 0);
		assert.match(lines[missingIdentity + 1], /◈33\.8k \(.*⇊2/);
		assert.doesNotMatch(lines[missingIdentity + 1], /62%/);
	});
});

describe("sticky terminal dashboard behavior", () => {
	it("maps failure, interrupt-dominant stop, ping, and abandoned-watch outcomes", () => {
		const failed = baseRun({ id: "failed", lifecycle: markFailed(createLifecycle(1_000), "boom", 5_000, 1) });
		const interrupted = baseRun({
			id: "interrupted",
			lifecycle: markFailed(
				markCompletionDetected(
					markInterruptRequested(workingLifecycle(), 4_000),
					{ reason: "sentinel", exitCode: 130 },
					5_000,
				),
				"exit 130",
				5_000,
				130,
			),
		});
		const ping = baseRun({
			id: "ping",
			lifecycle: markCompleted(
				markCompletionDetected(workingLifecycle(), { reason: "ping", exitCode: 0 }, 5_000),
				5_000,
			),
		});
		const abandoned = baseRun({
			id: "abandoned",
			lifecycle: markFailed(createLifecycle(1_000), "timeout", 5_000, 1),
		});

		assert.equal(testApi.captureStickyTerminalRun(failed, { exitCode: 1 }, 5_000), true);
		assert.equal(testApi.captureStickyTerminalRun(interrupted, { exitCode: 130 }, 5_100), true);
		assert.equal(
			testApi.captureStickyTerminalRun(ping, { exitCode: 0, ping: { name: "reviewer", message: "help" } }, 5_200),
			true,
		);
		assert.equal(testApi.captureStickyTerminalRun(abandoned, { exitCode: 1, watchAbandoned: true }, 5_300), true);

		assert.equal(testApi.stickyTerminalRuns.get("failed").kind, "failed");
		assert.equal(testApi.stickyTerminalRuns.get("interrupted").kind, "stopped");
		assert.equal(testApi.stickyTerminalRuns.get("ping").kind, "stopped");
		assert.equal(testApi.stickyTerminalRuns.get("abandoned").kind, "watch-abandoned");
		const renderSticky = (id: string) => render([], 120, [], [], [testApi.stickyTerminalRuns.get(id)]).join("\n");
		assert.match(renderSticky("failed"), /✗ Reviewer · \[failed\]/);
		assert.match(renderSticky("interrupted"), /■ Reviewer · \[interrupted\]/);
		assert.match(renderSticky("ping"), /■ Reviewer · \[ping\]/);
		assert.match(renderSticky("abandoned"), /⚠ Reviewer · \[abandoned\]/);
	});

	it("freezes duration and telemetry at capture while success, suppression, and shutdown aborts leave no row", () => {
		const activity = telemetry({ toolCount: 7 });
		const failed = baseRun({
			id: "snapshot",
			name: "audit pass",
			agent: "code-reviewer",
			activity,
			lifecycle: markFailed(createLifecycle(1_000), "boom", 12_300, 1),
		});
		assert.equal(testApi.captureStickyTerminalRun(failed, { exitCode: 1 }, 12_300), true);
		activity.toolCount = 99;
		const text = withNow(99_000, () =>
			render([], 120, [], [], Array.from(testApi.stickyTerminalRuns.values())).join("\n"),
		);
		assert.match(text, /11.3s/);
		assert.match(text, /⚙7/);
		assert.doesNotMatch(text, /⚙99|98s/);

		assert.equal(testApi.captureStickyTerminalRun(baseRun({ id: "success" }), { exitCode: 0 }), false);
		const suppressed = baseRun({ id: "suppressed", lifecycle: markDelivery(createLifecycle(1_000), "suppressed") });
		assert.equal(testApi.captureStickyTerminalRun(suppressed, { exitCode: 1 }), false);
		assert.equal(
			testApi.captureStickyTerminalRun(baseRun({ id: "abort" }), { exitCode: 1, error: "cancelled" }),
			false,
		);
	});

	it("refreshes the final sidecar before freezing sticky telemetry", () => {
		const dir = mkdtempSync(join(tmpdir(), "sticky-final-telemetry-"));
		const activityFile = join(dir, "activity.json");
		try {
			writeSubagentActivityFile(
				activityFile,
				telemetry({
					runningChildId: "final",
					latestEvent: "subagent_done",
					phase: "done",
					agentActive: false,
					turnActive: false,
					toolCount: 9,
				}),
			);
			const run = baseRun({
				id: "final",
				activityFile,
				activity: telemetry({ runningChildId: "final", toolCount: 1 }),
				lifecycle: markFailed(createLifecycle(1_000), "boom", 2_000, 1),
			});
			assert.equal(testApi.captureStickyTerminalRun(run, { exitCode: 1 }, 2_000), true);
			assert.equal(testApi.stickyTerminalRuns.get("final").activity.toolCount, 9);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("evicts all rows on the next admission and one correlated row on manual-resume completion", () => {
		for (const id of ["one", "two"]) {
			testApi.captureStickyTerminalRun(
				baseRun({ id, lifecycle: markFailed(createLifecycle(1_000), "boom", 2_000, 1) }),
				{ exitCode: 1 },
				2_000,
			);
		}
		testApi.clearStickyTerminalsOnAdmission();
		assert.equal(testApi.stickyTerminalRuns.size, 0);

		for (const id of ["old", "other", "failed-resume", "ping-resume", "abandoned-resume"]) {
			testApi.captureStickyTerminalRun(
				baseRun({ id, lifecycle: markFailed(createLifecycle(1_000), "boom", 2_000, 1) }),
				{ exitCode: 1 },
				2_000,
			);
		}
		testApi.evictResumedStickyTerminal(
			baseRun({
				id: "new",
				resumedStickyId: "old",
				activity: telemetry({ latestEvent: "subagent_done", phase: "done" }),
			}),
			{ exitCode: 0 },
		);
		testApi.evictResumedStickyTerminal(
			baseRun({
				id: "failed-new",
				resumedStickyId: "failed-resume",
				activity: telemetry({ latestEvent: "subagent_done", phase: "done" }),
			}),
			{ exitCode: 1 },
		);
		testApi.evictResumedStickyTerminal(
			baseRun({
				id: "ping-new",
				resumedStickyId: "ping-resume",
				activity: telemetry({ latestEvent: "caller_ping", phase: "done" }),
			}),
			{ exitCode: 0, ping: { name: "reviewer", message: "help" } },
		);
		testApi.evictResumedStickyTerminal(
			baseRun({
				id: "abandoned-new",
				resumedStickyId: "abandoned-resume",
				activity: telemetry({ latestEvent: "turn_end" }),
			}),
			{ exitCode: 1, watchAbandoned: true },
		);
		assert.equal(testApi.stickyTerminalRuns.has("old"), false);
		assert.equal(testApi.stickyTerminalRuns.has("other"), true);
		assert.equal(testApi.stickyTerminalRuns.has("failed-resume"), true);
		assert.equal(testApi.stickyTerminalRuns.has("ping-resume"), true);
		assert.equal(testApi.stickyTerminalRuns.has("abandoned-resume"), true);
	});

	it("orders newest sticky rows first, caps at three, and uses a bare hollow header", () => {
		const sticky = Array.from({ length: 5 }, (_, index) => ({
			id: `s${index + 1}`,
			name: "reviewer",
			agent: "reviewer",
			admissionClass: "background",
			startTime: 1_000,
			runtimeEndedAt: 2_000,
			kind: "failed",
			capturedAt: index,
		}));
		const lines = render([], 100, [], [], sticky);
		assert.match(lines[0], /^○ Subagents$/);
		const text = lines.join("\n");
		assert.ok(text.indexOf("[s5]") < text.indexOf("[s4]"));
		assert.ok(text.indexOf("[s4]") < text.indexOf("[s3]"));
		assert.doesNotMatch(text, /\[s2\]|\[s1\]/);
		assert.match(text, /\+2 more/);
	});

	it("keeps live headers counted and removes the widget when all work succeeds", () => {
		const live = withNow(10_000, () => render([baseRun()]));
		assert.match(live[0], /^● Subagents · 1 active$/);

		const calls: Array<[string, unknown]> = [];
		testApi.setLatestWidgetContext({
			hasUI: true,
			ui: {
				setWidget(name: string, value: unknown) {
					calls.push([name, value]);
				},
			},
		});
		testApi.updateWidget();
		assert.deepEqual(calls.at(-1), ["subagent-status", undefined]);
	});
});

describe("agents dashboard narrow-width degradation", () => {
	it("drops identity duration before truncating the display name", () => {
		const run = baseRun({
			id: "identity",
			name: "this is a deliberately long presentation label",
			agent: undefined,
			activity: telemetry(),
		});
		const outputs = new Map<number, string>();
		withNow(20_000, () => {
			for (let width = 20; width <= 100; width++) outputs.set(width, render([run], width)[1]);
		});
		const durationDropped = Array.from(outputs.entries()).find(
			([, line]) => line.includes("this is a deliberately long presentation label") && !line.includes("19s"),
		);
		assert.ok(durationDropped, "a width keeps the full name after dropping duration");
		const narrower = outputs.get(Math.max(20, durationDropped![0] - 8)) ?? "";
		assert.doesNotMatch(narrower, /this is a deliberately long presentation label/);
	});

	it("drops activity chunks right-to-left: compaction, percent, tools, then turns", () => {
		const run = baseRun({ activity: telemetry() });
		const activityAt = (width: number) => withNow(10_000, () => render([run], width)[2] ?? "");
		const widths = Array.from({ length: 137 }, (_, index) => index + 4);
		const compactionDropped = widths.find((width) => {
			const line = activityAt(width);
			return line.includes("62%") && line.includes("⚙5") && line.includes("↻5") && !line.includes("⇊2");
		});
		const percentDropped = widths.find((width) => {
			const line = activityAt(width);
			return line.includes("⚙5") && line.includes("↻5") && !line.includes("62%") && !line.includes("⇊2");
		});
		const toolsDropped = widths.find((width) => {
			const line = activityAt(width);
			return line.includes("↻5") && !line.includes("⚙5") && !line.includes("62%");
		});
		const turnsDropped = widths.find((width) => !activityAt(width).includes("↻5"));
		assert.ok(compactionDropped, "compaction-only degradation point exists");
		assert.ok(percentDropped, "percent-only degradation point exists");
		assert.ok(toolsDropped, "tool-only degradation point exists");
		assert.ok(turnsDropped, "turn degradation point exists");
		for (const width of [20, 32, 48, 80]) {
			for (const line of withNow(10_000, () => render([run], width))) {
				assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
			}
		}
	});
});
