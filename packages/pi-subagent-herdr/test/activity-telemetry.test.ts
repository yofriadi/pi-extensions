import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createSubagentActivityRecorder,
	readSubagentActivityFile,
	type SubagentActivityState,
	writeSubagentActivityFile,
} from "../src/activity.ts";
import { getSubagentArtifactDir, seedSubagentSessionFile } from "../src/session.ts";
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

describe("companion directory sidecar wiring", () => {
	type PiMock = {
		handlers: Map<string, Function>;
		registeredTools: Array<{ name: string; execute: Function }>;
		pi: unknown;
		ctx: {
			calls: { shutdown: number };
			ui: { setWidget(): void };
			getContextUsage(): unknown;
		};
	};

	function makePi(): PiMock {
		const handlers = new Map<string, Function>();
		const registeredTools: Array<{ name: string; execute: Function }> = [];
		const pi = {
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
			registerShortcut() {},
			registerTool(tool: { name: string; execute: Function }) {
				registeredTools.push(tool);
			},
			getAllTools() {
				return [];
			},
			getActiveTools() {
				return [];
			},
		};
		const ctx = {
			ui: { setWidget() {} },
			calls: { shutdown: 0 },
			getContextUsage() {
				return { tokens: 10_000, contextWindow: 100_000, percent: 10 };
			},
			shutdown() {
				this.calls.shutdown += 1;
			},
		};
		return { handlers, registeredTools, pi, ctx };
	}

	function childSession(name: string): { sessionFile: string; artifactDir: string; parentFile: string } {
		const dir = mkdtempSync(join(tmpdir(), "subagent-sidecar-wiring-"));
		tempDirs.push(dir);
		const parentFile = join(dir, "parent.jsonl");
		writeFileSync(parentFile, `${JSON.stringify({ type: "session", id: "parent-1" })}\n`);
		const sessionFile = join(dir, `${name}.jsonl`);
		seedSubagentSessionFile({
			parentSessionFile: parentFile,
			childSessionFile: sessionFile,
			childCwd: dir,
		});
		return { sessionFile, artifactDir: getSubagentArtifactDir(sessionFile), parentFile };
	}

	function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
		const previous: Record<string, string | undefined> = {};
		for (const key of Object.keys(vars)) {
			previous[key] = process.env[key];
			const value = vars[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		try {
			run();
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	it("flushes the final activity state before publishing exit.json and cannot recreate <stem>/ afterwards", () => {
		const { sessionFile, artifactDir } = childSession("flush-order");
		const mock = makePi();
		const activityFile = join(artifactDir, "activity.json");

		withEnv(
			{
				PI_SUBAGENT_SESSION: sessionFile,
				PI_SUBAGENT_ID: "flush-order-child",
				PI_SUBAGENT_ACTIVITY_FILE: activityFile,
				PI_SUBAGENT_AUTO_EXIT: "1",
			},
			() => {
				subagentDoneExtension(mock.pi as never);
				mock.handlers.get("session_start")?.({}, mock.ctx);
				mock.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, mock.ctx);
				mock.handlers.get("agent_settled")?.({}, mock.ctx);

				// The final done state and the sidecar must both exist, and the
				// recorded activity must already be terminal when the sidecar lands.
				const read = readSubagentActivityFile(activityFile, "flush-order-child");
				assert.equal(read.ok, true, "final activity state flushed");
				if (read.ok) {
					assert.equal(read.activity.phase, "done");
					assert.equal(read.activity.latestEvent, "agent_end");
				}
				assert.equal(existsSync(join(artifactDir, "exit.json")), true, "exit.json published");
				assert.equal(mock.ctx.calls.shutdown, 1);
			},
		);

		// The parent's successful settlement deletes <stem>/. A late recorder
		// event must not recreate the directory — the recorder is disabled
		// before the sidecar was ever visible.
		rmSync(artifactDir, { recursive: true, force: true });
		mock.handlers.get("tool_execution_end")?.({ toolCallId: "late", toolName: "read" }, mock.ctx);
		mock.handlers.get("message_update")?.({}, mock.ctx);
		assert.equal(existsSync(artifactDir), false, "a disabled recorder must not recreate <stem>/");
	});

	it("creates a missing companion directory with 0o700 when the sidecar writer is the first creator", () => {
		const { sessionFile, artifactDir } = childSession("first-creator");
		const mock = makePi();

		withEnv(
			{
				PI_SUBAGENT_SESSION: sessionFile,
				PI_SUBAGENT_ID: "first-creator-child",
				// Deliberately NO PI_SUBAGENT_ACTIVITY_FILE: the recorder is a no-op,
				// so the subagent_done tool's sidecar writer must create <stem>/ itself.
				PI_SUBAGENT_ACTIVITY_FILE: undefined,
			},
			() => {
				subagentDoneExtension(mock.pi as never);
				const tool = mock.registeredTools.find((t) => t.name === "subagent_done");
				assert.ok(tool, "subagent_done tool registered");
				rmSync(artifactDir, { recursive: true, force: true });
				assert.equal(existsSync(artifactDir), false);
				void tool.execute("call-1", {}, new AbortController().signal, () => {}, mock.ctx);
				assert.equal(existsSync(artifactDir), true, "companion directory created");
				assert.equal(statSync(artifactDir).mode & 0o777, 0o700, "created 0o700");
				assert.equal(existsSync(join(artifactDir, "exit.json")), true, "exit.json written");
				assert.equal(existsSync(`${sessionFile}.exit`), false, "no flat legacy sidecar path");
				assert.equal(mock.ctx.calls.shutdown, 1);
			},
		);
	});
});
