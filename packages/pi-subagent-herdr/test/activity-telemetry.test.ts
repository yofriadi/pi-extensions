import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createSubagentActivityRecorder,
	readSubagentActivityFile,
	type SubagentActivityState,
	writeSubagentActivityFile,
} from "../src/activity.ts";
import subagentDoneExtension from "../src/subagent-done.ts";

const tempDirs: string[] = [];

function tempFile(name = "activity.json"): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-activity-telemetry-"));
	tempDirs.push(dir);
	return join(dir, name);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function baseActivity(overrides: Partial<SubagentActivityState> = {}): SubagentActivityState {
	return {
		version: 1,
		runningChildId: "child",
		createdAt: 1,
		updatedAt: 2,
		sequence: 1,
		latestEvent: "agent_start",
		phase: "active",
		agentActive: true,
		turnActive: true,
		providerActive: false,
		toolActive: false,
		...overrides,
	};
}

describe("activity telemetry schema and recorder", () => {
	it("increments counters and retains last-known tokens while percent is unavailable", () => {
		const activityFile = tempFile();
		let now = 1_000;
		const recorder = createSubagentActivityRecorder({
			runningChildId: "child",
			activityFile,
			now: () => now++,
		});

		recorder.sessionStart();
		recorder.toolExecutionEnd("tool-1", "read");
		recorder.toolExecutionEnd("tool-2", "bash");
		recorder.contextUsage(33_800, 128_000, 26.40625);
		recorder.compaction();

		const read = readSubagentActivityFile(activityFile, "child");
		assert.equal(read.ok, true);
		if (!read.ok) return;
		assert.equal(read.activity.toolCount, 2);
		assert.equal(read.activity.compactionCount, 1);
		assert.equal(read.activity.contextTokens, 33_800);
		assert.equal(read.activity.contextWindow, 128_000);
		assert.equal(read.activity.contextPercent, null);
	});

	it("round-trips both old and telemetry-bearing version-1 states and ignores unknown keys", () => {
		const oldFile = tempFile("old.json");
		writeSubagentActivityFile(oldFile, baseActivity());
		const oldRead = readSubagentActivityFile(oldFile, "child");
		assert.equal(oldRead.ok, true);
		if (oldRead.ok) assert.equal(oldRead.activity.toolCount, undefined);

		const telemetryFile = tempFile("telemetry.json");
		const telemetry = {
			...baseActivity(),
			toolCount: 4,
			contextTokens: 91_000,
			contextWindow: 108_000,
			contextPercent: 84.25,
			compactionCount: 2,
			futureField: "ignored",
		} as SubagentActivityState;
		writeSubagentActivityFile(telemetryFile, telemetry);
		const telemetryRead = readSubagentActivityFile(telemetryFile, "child");
		assert.equal(telemetryRead.ok, true);
		if (telemetryRead.ok) {
			assert.equal(telemetryRead.activity.toolCount, 4);
			assert.equal(telemetryRead.activity.contextTokens, 91_000);
			assert.equal(telemetryRead.activity.contextWindow, 108_000);
			assert.equal(telemetryRead.activity.contextPercent, 84.25);
			assert.equal(telemetryRead.activity.compactionCount, 2);
		}
	});

	it("rejects invalid telemetry values", () => {
		const invalidCases: Array<[keyof SubagentActivityState, unknown, RegExp]> = [
			["toolCount", 1.5, /toolCount must be an integer/],
			["contextTokens", "NaN", /contextTokens must be finite/],
			["contextWindow", "Infinity", /contextWindow must be finite/],
			["contextPercent", "84", /contextPercent must be finite/],
			["compactionCount", 2.25, /compactionCount must be an integer/],
		];

		for (const [field, value, expected] of invalidCases) {
			const file = tempFile(`${String(field)}.json`);
			writeSubagentActivityFile(file, { ...baseActivity(), [field]: value } as SubagentActivityState);
			const read = readSubagentActivityFile(file, "child");
			assert.equal(read.ok, false, field);
			if (!read.ok) assert.match(read.error ?? "", expected, field);
		}
	});
});

describe("child telemetry event wiring", () => {
	it("samples settle points and counts tool completions and compactions", () => {
		const activityFile = tempFile();
		const previousId = process.env.PI_SUBAGENT_ID;
		const previousFile = process.env.PI_SUBAGENT_ACTIVITY_FILE;
		process.env.PI_SUBAGENT_ID = "wired-child";
		process.env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;

		const handlers = new Map<string, Function>();
		const registeredTools: string[] = [];
		const pi = {
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
			registerShortcut() {},
			registerTool(tool: { name: string }) {
				registeredTools.push(tool.name);
			},
			getAllTools() {
				return [];
			},
			getActiveTools() {
				return [];
			},
		};
		let samples = 0;
		const ctx = {
			ui: { setWidget() {} },
			getContextUsage() {
				samples += 1;
				return { tokens: 10_000 * samples, contextWindow: 100_000, percent: 10 * samples };
			},
		};

		try {
			subagentDoneExtension(pi as never);
			assert.deepEqual(registeredTools, ["subagent_done"]);
			handlers.get("session_start")?.({}, ctx);
			handlers.get("turn_end")?.({ turnIndex: 3 }, ctx);
			handlers.get("after_provider_response")?.({}, ctx);
			handlers.get("tool_execution_end")?.({ toolCallId: "t1", toolName: "read" }, ctx);
			handlers.get("session_compact")?.({}, ctx);

			assert.equal(samples, 3);
			const read = readSubagentActivityFile(activityFile, "wired-child");
			assert.equal(read.ok, true);
			if (!read.ok) return;
			assert.equal(read.activity.turnIndex, 3);
			assert.equal(read.activity.toolCount, 1);
			assert.equal(read.activity.compactionCount, 1);
			assert.equal(read.activity.contextTokens, 30_000);
			assert.equal(read.activity.contextWindow, 100_000);
			assert.equal(read.activity.contextPercent, null);

			handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
			handlers.get("agent_settled")?.({}, ctx);
			const interrupted = readSubagentActivityFile(activityFile, "wired-child");
			assert.equal(interrupted.ok, true);
			if (!interrupted.ok) return;
			assert.equal(interrupted.activity.latestEvent, "agent_interrupted");
			assert.equal(interrupted.activity.phase, "waiting");
			assert.equal(interrupted.activity.interruptedAt, interrupted.activity.updatedAt);
			assert.equal(interrupted.activity.interruptedSequence, interrupted.activity.sequence);
		} finally {
			if (previousId == null) delete process.env.PI_SUBAGENT_ID;
			else process.env.PI_SUBAGENT_ID = previousId;
			if (previousFile == null) delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
			else process.env.PI_SUBAGENT_ACTIVITY_FILE = previousFile;
		}
	});
});
