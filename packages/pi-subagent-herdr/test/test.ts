import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSubagentActivityRecorder, getSubagentActivityFile, readSubagentActivityFile } from "../src/activity.ts";
import { interpretExitSidecar, waitForCompletion } from "../src/completion.ts";
import { __herdrTest__, isHerdrAvailable } from "../src/herdr.ts";
import * as subagentsModule from "../src/index.ts";
import {
	cleanupSubagentsForShutdown,
	settleParentShutdown,
	shouldDeliverSubagentCompletion,
	shouldPreserveSubagentsOnShutdown,
} from "../src/index.ts";
import {
	createLifecycle,
	lifecycleTransition,
	markCompleted,
	markCompletionDetected,
	markFailed,
	markInterruptRequested,
	observeActivity as observeLifecycleActivity,
	observePaneInspection,
	projectLifecycle,
} from "../src/lifecycle.ts";
import {
	appendBranchSummary,
	copySessionFile,
	findLastAssistantMessage,
	findObservedSessionRuntime,
	getLeafId,
	getNewEntries,
	mergeNewEntries,
	seedSubagentSessionFile,
} from "../src/session.ts";
import {
	advanceStatusState,
	capStatusLines,
	classifyStatus,
	createStatusState,
	DEFAULT_STATUS_LINE_LIMIT,
	forceStatusAfterInterrupt,
	formatStatusAggregate,
	formatStatusLine,
	formatTransitionLine,
	observeStatus,
	STATUS_CONFIG,
} from "../src/status.ts";
import {
	buildCompletionSidecar,
	didLatestAssistantAbort,
	findLatestAssistantError,
	injectSelectedSkillMetadata,
	parseSelectedSkillMetadata,
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
} from "../src/subagent-done.ts";
import { createTaggedWidgetTheme } from "./widget-theme.ts";

// Tool-registration behavior is environment-sensitive for child subagents.
// Isolate the unit suite from inherited parent/child capability variables.
const inheritedSubagentId = process.env.PI_SUBAGENT_ID;
const inheritedDenyTools = process.env.PI_DENY_TOOLS;
before(() => {
	delete process.env.PI_SUBAGENT_ID;
	delete process.env.PI_DENY_TOOLS;
});
after(() => {
	if (inheritedSubagentId == null) delete process.env.PI_SUBAGENT_ID;
	else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
	if (inheritedDenyTools == null) delete process.env.PI_DENY_TOOLS;
	else process.env.PI_DENY_TOOLS = inheritedDenyTools;
});

// --- Helpers ---

function createTestDir(): string {
	return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
	const file = join(dir, "test-session.jsonl");
	const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
	writeFileSync(file, content);
	return file;
}

function withTempDir(run: (dir: string) => void) {
	const dir = createTestDir();
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function createMockExtensionApi() {
	const registeredTools: Array<any> = [];
	const registeredCommands: Array<any> = [];
	const registeredMessageRenderers: Array<any> = [];
	const eventHandlers = new Map<string, Array<Function>>();
	const sentUserMessages: string[] = [];
	const sentMessages: Array<any> = [];
	return {
		registeredTools,
		registeredCommands,
		registeredMessageRenderers,
		eventHandlers,
		sentUserMessages,
		sentMessages,
		api: {
			on(event: string, handler: Function) {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
			},
			registerTool(tool: any) {
				registeredTools.push(tool);
			},
			registerCommand(name: string, command: any) {
				registeredCommands.push({ name, ...command });
			},
			registerMessageRenderer(name: string, renderer: any) {
				registeredMessageRenderers.push({ name, renderer });
			},
			registerShortcut() {},
			sendUserMessage(message: string) {
				sentUserMessages.push(message);
			},
			sendMessage(message: any, options?: any) {
				sentMessages.push({ message, options });
			},
			getAllTools() {
				return [];
			},
		} as any,
	};
}

function restoreEnvVar(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = originalNow;
	}
}

function writeAgentFile(agentsDir: string, name: string, frontmatter: string, body = "You are a test agent.") {
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
	fn: (paths: {
		projectDir: string;
		projectAgentsDir: string;
		globalDir: string;
		globalAgentsDir: string;
	}) => Promise<void> | void,
) {
	const root = createTestDir();
	const previousCwd = process.cwd();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const projectDir = join(root, "project");
	const projectAgentsDir = join(projectDir, ".pi", "agents");
	const globalDir = join(root, "global");
	const globalAgentsDir = join(globalDir, "agents");

	mkdirSync(projectAgentsDir, { recursive: true });
	mkdirSync(globalAgentsDir, { recursive: true });
	process.chdir(projectDir);
	process.env.PI_CODING_AGENT_DIR = globalDir;

	try {
		await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
	} finally {
		process.chdir(previousCwd);
		restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
		rmSync(root, { recursive: true, force: true });
	}
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
	type: "message",
	id: "user-001",
	parentId: "mc-001",
	message: {
		role: "user",
		content: [{ type: "text", text: "Hello, plan something" }],
	},
};
const ASSISTANT_MSG = {
	type: "message",
	id: "asst-001",
	parentId: "user-001",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Here is my plan..." }],
	},
};
const ASSISTANT_MSG_2 = {
	type: "message",
	id: "asst-002",
	parentId: "asst-001",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Let me think..." },
			{ type: "text", text: "Updated plan with details." },
		],
	},
};
const TOOL_RESULT = {
	type: "message",
	id: "tool-001",
	parentId: "asst-001",
	message: {
		role: "toolResult",
		toolCallId: "tc-001",
		toolName: "bash",
		content: [{ type: "text", text: "output here" }],
	},
};

// --- Tests ---

describe("session.ts", () => {
	let dir: string;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("getLeafId", () => {
		it("returns last entry id", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
			assert.equal(getLeafId(file), "asst-001");
		});

		it("returns null for empty file", () => {
			const file = join(dir, "empty.jsonl");
			writeFileSync(file, "");
			assert.equal(getLeafId(file), null);
		});
	});

	describe("getNewEntries", () => {
		it("returns entries after a given line", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 2);
			assert.equal(entries[0].id, "user-001");
			assert.equal(entries[1].id, "asst-001");
		});

		it("returns empty array when no new entries", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 0);
		});
	});

	describe("findLastAssistantMessage", () => {
		it("finds last assistant text", () => {
			const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Updated plan with details.");
		});

		it("skips thinking blocks, gets text only", () => {
			const entries = [ASSISTANT_MSG_2] as any[];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Updated plan with details.");
		});

		it("skips tool results", () => {
			const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Here is my plan...");
		});

		it("returns null when no assistant messages", () => {
			const entries = [USER_MSG] as any[];
			assert.equal(findLastAssistantMessage(entries), null);
		});

		it("returns null for empty array", () => {
			assert.equal(findLastAssistantMessage([]), null);
		});

		it("does not reuse older text when the newest assistant message is empty", () => {
			const realMsg = {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Real summary content." }],
				},
			};
			const emptyMsg = {
				type: "message",
				message: {
					role: "assistant",
					content: [],
				},
			};
			const entries = [realMsg, emptyMsg] as any[];
			assert.equal(findLastAssistantMessage(entries), null);
		});

		it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
			// Reproduces the overload-exhaustion case: an earlier turn looked
			// normal, then the provider went 529 and auto-retry gave up. Without
			// the errorMessage fallback we'd return the stale earlier summary and
			// the orchestrator would believe the subagent completed.
			const earlierGood = {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Investigating the bug..." }],
				},
			};
			const overloadError = {
				type: "message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Anthropic 529 Overloaded after 3 retries",
				},
			};
			const entries = [earlierGood, overloadError] as any[];
			assert.equal(findLastAssistantMessage(entries), "Subagent error: Anthropic 529 Overloaded after 3 retries");
		});

		it("prefers text content even when an error stopReason is set", () => {
			// If the model produced text before the error (rare but possible), we
			// prefer the actual content over the synthetic error fallback.
			const msg = {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Here is partial output." }],
					stopReason: "error",
					errorMessage: "stream interrupted",
				},
			};
			assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
		});

		it("does not invent a summary for a stop=error message with no errorMessage", () => {
			const msg = {
				type: "message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
				},
			};
			assert.equal(findLastAssistantMessage([msg] as any[]), null);
		});
	});

	describe("findObservedSessionRuntime", () => {
		it("extracts the latest model and thinking entries", () => {
			assert.deepEqual(
				findObservedSessionRuntime([
					{ type: "model_change", id: "m1", provider: "fake", modelId: "old" },
					{ type: "thinking_level_change", id: "t1", thinkingLevel: "medium" },
					{ type: "model_change", id: "m2", provider: "other", modelId: "new" },
				]),
				{ provider: "other", modelId: "new", thinking: "medium" },
			);
		});
	});

	describe("appendBranchSummary", () => {
		it("appends valid branch_summary entry", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
			const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

			assert.ok(id, "should return an id");
			assert.equal(typeof id, "string");

			// Read back and verify
			const lines = readFileSync(file, "utf8").trim().split("\n");
			assert.equal(lines.length, 4); // 3 original + 1 summary

			const summary = JSON.parse(lines[3]);
			assert.equal(summary.type, "branch_summary");
			assert.equal(summary.id, id);
			assert.equal(summary.parentId, "user-001");
			assert.equal(summary.fromId, "asst-001");
			assert.equal(summary.summary, "The plan was created.");
			assert.ok(summary.timestamp);
		});

		it("uses branchPointId as fromId fallback", () => {
			const file = createSessionFile(dir, [SESSION_HEADER]);
			appendBranchSummary(file, "branch-pt", null, "summary");

			const lines = readFileSync(file, "utf8").trim().split("\n");
			const summary = JSON.parse(lines[1]);
			assert.equal(summary.fromId, "branch-pt");
		});
	});

	describe("copySessionFile", () => {
		it("creates a copy with different path", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
			const copyDir = join(dir, "copies");
			mkdirSync(copyDir, { recursive: true });
			const copy = copySessionFile(file, copyDir);

			assert.notEqual(copy, file);
			assert.ok(copy.endsWith(".jsonl"));
			assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
		});
	});

	describe("seedSubagentSessionFile", () => {
		it("creates a lineage-only child session with parent linkage and no copied turns", () => {
			const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
			const childFile = join(dir, "lineage-child.jsonl");

			seedSubagentSessionFile({
				mode: "lineage-only",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd: "/tmp/child-cwd",
			});

			const lines = readFileSync(childFile, "utf8").trim().split("\n");
			assert.equal(lines.length, 1);

			const header = JSON.parse(lines[0]);
			assert.equal(header.type, "session");
			assert.equal(header.parentSession, parentFile);
			assert.equal(header.cwd, "/tmp/child-cwd");
		});

		it("writes owner-only provenance with strict permissions when canonical identity is supplied", () => {
			const parentFile = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
			const childFile = join(dir, "owned-child.jsonl");

			seedSubagentSessionFile({
				mode: "fresh",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd: "/tmp/owned-child-cwd",
				agentId: "reviewer",
				parentSessionId: "parent-session-1",
			});

			const header = JSON.parse(readFileSync(childFile, "utf8").trim());
			const ownerFile = `${childFile}.owner.json`;
			const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
			assert.equal(header.subagentOwner.agentId, "reviewer");
			assert.equal(header.subagentOwner.parentSessionId, "parent-session-1");
			assert.match(header.subagentOwner.token, /^[a-f0-9]{64}$/);
			assert.equal(owner.agentId, "reviewer");
			assert.equal(owner.parentSessionId, "parent-session-1");
			assert.equal(owner.parentSessionFile, parentFile);
			assert.equal(owner.token, header.subagentOwner.token);
			assert.equal(statSync(childFile).mode & 0o777, 0o600);
			assert.equal(statSync(ownerFile).mode & 0o777, 0o600);
		});

		it("creates a forked child session with copied context before the triggering user turn", () => {
			const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
			const childFile = join(dir, "fork-child.jsonl");

			seedSubagentSessionFile({
				mode: "fork",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd: "/tmp/fork-child-cwd",
			});

			const entries = readFileSync(childFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(entries.length, 2);
			assert.equal(entries[0].type, "session");
			assert.equal(entries[0].parentSession, parentFile);
			assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
			assert.equal(entries[1].type, "model_change");
			assert.equal(
				entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile),
				false,
			);
			assert.equal(
				entries.some((entry) => entry.type === "message"),
				false,
			);
		});
	});

	describe("mergeNewEntries", () => {
		it("appends new entries from source to target", () => {
			// Source starts with same base (2 entries), then has 1 new entry
			const sourceFile = join(dir, "merge-source.jsonl");
			const targetFile = join(dir, "merge-target.jsonl");
			writeFileSync(
				sourceFile,
				`${[SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n")}\n`,
			);
			writeFileSync(targetFile, `${[SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n")}\n`);

			// Merge entries after line 2 (the shared base)
			const merged = mergeNewEntries(sourceFile, targetFile, 2);
			assert.equal(merged.length, 1);
			assert.equal(merged[0].id, "asst-001");

			// Target should now have 3 entries
			const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
			assert.equal(targetLines.length, 3);
		});
	});
});

describe("status.ts", () => {
	it("exposes always-on status config with fixed line limit", () => {
		assert.deepEqual(STATUS_CONFIG, {
			enabled: true,
			lineLimit: DEFAULT_STATUS_LINE_LIMIT,
		});
		assert.equal(DEFAULT_STATUS_LINE_LIMIT, 4);
	});

	it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
		let state = createStatusState({ source: "pi", startTimeMs: 0 });
		state = observeStatus(state, { snapshot: "missing" }, 1_000);

		assert.equal(classifyStatus(state, 60_999).kind, "starting");
		const stalled = classifyStatus(state, 61_000);
		assert.equal(stalled.kind, "stalled");
		assert.equal(stalled.statusLabel, null);
	});

	it("classifies active snapshots without aging into stalled", () => {
		let state = createStatusState({ source: "pi", startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
				latestEvent: "tool_execution_start",
			},
			5_000,
		);

		const snapshot = classifyStatus(state, 240_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(snapshot.activityLabel, "bash");
		assert.equal(snapshot.activeDurationText, "3m");
	});

	it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
		let state = createStatusState({ source: "pi", startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 10_000,
				sequence: 1,
				phase: "waiting",
				waitingSince: 10_000,
				latestEvent: "agent_end",
			},
			10_000,
		);

		const snapshot = classifyStatus(state, 240_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.waitingDurationText, "3m");
	});

	it("detects stalled transitions and recovery", () => {
		let state = createStatusState({ source: "pi", startTimeMs: 0 });
		state = observeStatus(state, { snapshot: "missing" }, 1_000);

		let advanced = advanceStatusState(state, 95_000);
		assert.equal(advanced.transition, "stalled");
		assert.equal(advanced.snapshot.kind, "stalled");

		state = observeStatus(
			advanced.nextState,
			{
				snapshot: "present",
				updatedAt: 96_000,
				sequence: 1,
				phase: "waiting",
				waitingSince: 96_000,
				latestEvent: "agent_end",
			},
			96_000,
		);
		advanced = advanceStatusState(state, 97_000);
		assert.equal(advanced.transition, "recovered");
		assert.equal(advanced.snapshot.kind, "waiting");
	});

	it("keeps the last healthy kind during transient snapshot loss", () => {
		let state = createStatusState({ source: "pi", startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "streaming",
				activeSince: 5_000,
			},
			5_000,
		);
		state = advanceStatusState(state, 6_000).nextState;
		state = observeStatus(state, { snapshot: "missing" }, 10_000);

		const snapshot = classifyStatus(state, 20_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(snapshot.statusLabel, null);
	});

	it("forces an active state to waiting after interrupt", () => {
		const now = 20_000;
		let state = createStatusState({ source: "pi", startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			5_000,
		);

		assert.equal(classifyStatus(state, now).kind, "active");

		const forced = forceStatusAfterInterrupt(state, now);
		const snapshot = classifyStatus(forced, now);

		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.activityLabel, "interrupted");
		assert.equal(snapshot.waitingDurationText, "0s");
		assert.equal(forced.activeNow, false);
	});

	it("orders same-millisecond snapshots by sequence", () => {
		let state = createStatusState({ source: "pi", startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 10_000,
				sequence: 2,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 10_000,
				activityLabel: "bash",
			},
			10_000,
		);

		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 10_000,
				sequence: 3,
				phase: "waiting",
				waitingSince: 10_000,
				latestEvent: "agent_end",
			},
			10_001,
		);

		const snapshot = classifyStatus(state, 11_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.latestEvent, "agent_end");
	});

	it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
		let state = createStatusState({ source: "pi", startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 2,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			5_000,
		);
		state = observeStatus(state, { snapshot: "missing" }, 10_000);
		assert.equal(classifyStatus(state, 10_000).statusLabel, null);

		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 2,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			11_000,
		);

		const snapshot = classifyStatus(state, 11_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(snapshot.statusLabel, null);
	});

	it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
		let state = createStatusState({ source: "pi", startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			5_000,
		);
		state = forceStatusAfterInterrupt(state, 20_000);

		const stale = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			21_000,
		);
		let snapshot = classifyStatus(stale, 21_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.activityLabel, "interrupted");

		const sameTimestamp = observeStatus(
			stale,
			{
				snapshot: "present",
				updatedAt: 20_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 20_000,
				activityLabel: "bash",
			},
			22_000,
		);
		snapshot = classifyStatus(sameTimestamp, 22_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.activityLabel, "interrupted");

		const resumed = observeStatus(
			sameTimestamp,
			{
				snapshot: "present",
				sequence: 2,
				updatedAt: 25_000,
				phase: "active",
				active: true,
				activeScope: "streaming",
				activeSince: 25_000,
				activityLabel: "streaming",
			},
			25_000,
		);
		snapshot = classifyStatus(resumed, 25_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(resumed.activeScope, "streaming");
	});

	it("normalizes and truncates long newline-heavy names", () => {
		const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
		const stalledState = observeStatus(
			createStatusState({ source: "pi", startTimeMs: 0 }),
			{ snapshot: "missing" },
			1_000,
		);
		const activeState = observeStatus(
			createStatusState({ source: "pi", startTimeMs: 0 }),
			{
				snapshot: "present",
				updatedAt: 299_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 299_000,
				activityLabel: "write",
			},
			299_000,
		);
		const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
		const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

		assert.doesNotMatch(line, /\n/);
		assert.doesNotMatch(recovered, /\n/);
		assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
		assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
	});

	it("caps visible status lines and reports overflow consistently", () => {
		const waitingState = observeStatus(
			createStatusState({ source: "pi", startTimeMs: 0 }),
			{ snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
			180_000,
		);
		const activeState = observeStatus(
			createStatusState({ source: "pi", startTimeMs: 0 }),
			{
				snapshot: "present",
				updatedAt: 419_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 419_000,
				activityLabel: "bash",
			},
			419_000,
		);
		const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
		const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
		const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
		const capped = capStatusLines(lines, 3);
		const aggregate = formatStatusAggregate(lines, 3);

		assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
		assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
		assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
		assert.equal(capped.overflow, 2);
		assert.match(aggregate, /^Subagent status:/);
		assert.match(aggregate, /\+2 more running\./);
		assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
	});
});

describe("strict subagent definitions", () => {
	const testApi = (subagentsModule as any).__test__;

	it("requires canonical filename-stem IDs", () => {
		for (const value of [undefined, "", "../scout", "a/b", "Agent", "<agent>", 'a"b']) {
			assert.throws(() => testApi.validateCanonicalAgentId(value), /subagent agent/i);
		}
		assert.equal(testApi.validateCanonicalAgentId("reviewer.v2"), "reviewer.v2");
	});

	it("parses the owned schema and preserves permission frontmatter untouched", () => {
		const content = [
			"---",
			"name: reviewer",
			"model: fake/reviewer",
			"thinking: high",
			"tools: read,grep",
			"skills: review, lint",
			"seed: fork",
			"permission:",
			"  bash: deny",
			"---",
			"You are the reviewer.",
			"",
		].join("\n");
		const parsed = testApi.parseAgentDefinition(content, "reviewer", "/tmp/reviewer.md", "global");
		assert.equal(parsed.id, "reviewer");
		assert.equal(parsed.model, "fake/reviewer");
		assert.equal(parsed.thinking, "high");
		assert.equal(parsed.tools, "read,grep");
		assert.equal(parsed.skills, "review, lint");
		assert.equal(parsed.seed, "fork");
		assert.equal(parsed.body, "You are the reviewer.");
		assert.match(parsed.frontmatter, /permission:\n {2}bash: deny/);
	});

	it("rejects missing, empty, and malformed tools profiles before admission", () => {
		for (const frontmatter of [
			"name: reviewer",
			"name: reviewer\ntools:",
			"name: reviewer\ntools: null",
			"name: reviewer\ntools: false",
			"name: reviewer\ntools: 123",
			"name: reviewer\ntools: [read, bash]",
			"name: reviewer\ntools: {read: true}",
			"name: reviewer\ntools: read,",
		]) {
			assert.throws(
				() => testApi.parseAgentDefinition(`---\n${frontmatter}\n---\nBody\n`, "reviewer", "/tmp/reviewer.md"),
				/tools/i,
			);
		}
		const quoted = testApi.parseAgentDefinition(
			'---\nname: reviewer\ntools: "read,bash"\n---\nBody\n',
			"reviewer",
			"/tmp/reviewer.md",
		);
		assert.equal(quoted.tools, "read,bash");
	});

	it("rejects a mismatched name, obsolete system-prompt, and invalid seed", () => {
		assert.throws(
			() => testApi.parseAgentDefinition("---\nname: other\n---\nbody\n", "reviewer", "/tmp/reviewer.md"),
			/name must match filename/,
		);
		assert.throws(
			() =>
				testApi.parseAgentDefinition("---\nsystem-prompt: append\n---\nbody\n", "reviewer", "/tmp/reviewer.md"),
			/obsolete system-prompt/,
		);
		assert.throws(
			() => testApi.parseAgentDefinition("---\nseed: sideways\n---\nbody\n", "reviewer", "/tmp/reviewer.md"),
			/seed must be fresh or fork/,
		);
	});

	it("uses trusted project precedence, untrusted global fallback, and no fallback", async () => {
		await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir, globalDir, globalAgentsDir }) => {
			writeAgentFile(globalAgentsDir, "reviewer", "name: reviewer\nmodel: fake/global\ntools: read", "global");
			writeAgentFile(projectAgentsDir, "reviewer", "name: reviewer\nmodel: fake/project\ntools: read", "project");
			assert.equal(
				testApi.loadAgentDefinition({
					id: "reviewer",
					cwd: projectDir,
					agentDir: globalDir,
					projectTrusted: true,
				}).model,
				"fake/project",
			);
			assert.equal(
				testApi.loadAgentDefinition({
					id: "reviewer",
					cwd: projectDir,
					agentDir: globalDir,
					projectTrusted: false,
				}).model,
				"fake/global",
			);
			assert.throws(
				() =>
					testApi.loadAgentDefinition({
						id: "missing",
						cwd: projectDir,
						agentDir: globalDir,
						projectTrusted: false,
					}),
				/^AgentDefinitionError: Unknown subagent "missing"\.$/,
			);
		});
	});

	it("uses agent seed only and builds fresh/fork launch behavior", () => {
		assert.deepEqual(testApi.resolveLaunchBehavior({ seed: "fresh" }), {
			seed: "fresh",
			inheritsConversationContext: false,
			taskDelivery: "artifact",
		});
		assert.deepEqual(testApi.resolveLaunchBehavior({ seed: "fork" }), {
			seed: "fork",
			inheritsConversationContext: true,
			taskDelivery: "direct",
		});
	});

	it("keeps agent tools authoritative and adds protocol controls", () => {
		assert.equal(testApi.buildSubagentToolAllowlist("read,bash"), "read,bash,subagent_done");
		assert.throws(() => testApi.buildSubagentToolAllowlist(undefined), /explicit non-empty allowlist/);
	});

	it("includes stable run IDs in same-second launch artifact names", () => {
		const timestamp = "2026-08-05T13-31-28";
		const first = testApi.buildLaunchArtifactName("reviewer", timestamp, "a".repeat(32));
		const second = testApi.buildLaunchArtifactName("reviewer", timestamp, "b".repeat(32));
		assert.notEqual(first, second);
		assert.match(first, /reviewer-2026-08-05T13-31-28-a{32}\.md$/);
		assert.match(second, /reviewer-2026-08-05T13-31-28-b{32}\.md$/);
	});

	it("normalizes ordered selected skills and rejects empty/duplicate names", () => {
		assert.deepEqual(testApi.parseSelectedSkillNames("review, lint"), ["review", "lint"]);
		assert.deepEqual(testApi.parseSelectedSkillNames(undefined), []);
		assert.throws(() => testApi.parseSelectedSkillNames("review,,lint"), /empty skill name/);
		assert.throws(() => testApi.parseSelectedSkillNames("review, review"), /duplicate "review"/);
	});

	it("registers only the minimal subagent schema and no listing tool", () => {
		const { api, registeredTools } = createMockExtensionApi();
		(subagentsModule as any).default(api);
		const tool = registeredTools.find((candidate) => candidate.name === "subagent");
		assert.ok(tool);
		assert.deepEqual(tool.parameters.required.sort(), ["agent", "task"]);
		assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
			"agent",
			"blocking",
			"direction",
			"label",
			"layout",
			"surface",
			"task",
		]);
		assert.equal(
			registeredTools.some((candidate) => candidate.name === "subagents_list"),
			false,
		);
	});
});
describe("selected skill prompt metadata", () => {
	it("creates one standard escaped container without skill bodies", () => {
		const output = injectSelectedSkillMetadata("base prompt", [
			{
				name: "a&b",
				description: "use <care>",
				filePath: "/tmp/a&b/SKILL.md",
			},
		]);
		assert.equal((output.match(/<available_skills>/g) ?? []).length, 1);
		assert.match(output, /<name>a&amp;b<\/name>/);
		assert.match(output, /<description>use &lt;care&gt;<\/description>/);
		assert.match(output, /<location>\/tmp\/a&amp;b\/SKILL\.md<\/location>/);
		assert.doesNotMatch(output, /full skill body/);
	});

	it("replaces an existing container and rejects multiple containers", () => {
		const skill = [{ name: "review", description: "Review", filePath: "/x/SKILL.md" }];
		const mixed = injectSelectedSkillMetadata("a\n<available_skills>old</available_skills>\nb", skill);
		assert.equal((mixed.match(/<available_skills>/g) ?? []).length, 1);
		assert.doesNotMatch(mixed, />old</);
		assert.throws(
			() =>
				injectSelectedSkillMetadata(
					"<available_skills></available_skills>\n<available_skills></available_skills>",
					skill,
				),
			/multiple available_skills/,
		);
	});

	it("parses selected metadata and rejects malformed environment payloads", () => {
		assert.deepEqual(parseSelectedSkillMetadata('[{"name":"x","description":"d","filePath":"/x"}]'), [
			{ name: "x", description: "d", filePath: "/x" },
		]);
		assert.throws(() => parseSelectedSkillMetadata("{}"), /Invalid selected skill metadata/);
	});
});

describe("subagent-done.ts", () => {
	describe("shouldMarkUserTookOver", () => {
		it("ignores the initial injected task before the first agent run", () => {
			assert.equal(shouldMarkUserTookOver(false), false);
		});

		it("treats later input as manual takeover", () => {
			assert.equal(shouldMarkUserTookOver(true), true);
		});
	});

	describe("shouldAutoExitOnAgentEnd", () => {
		it("auto-exits after normal completion when there was no takeover", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
		});

		it("auto-exits after normal completion even when the user sent the prompt", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
		});

		it("stays open after Escape aborts the run", () => {
			const messages = [{ role: "assistant", stopReason: "aborted" }];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
		});

		it("recognizes aborted assistant turns for interrupted activity telemetry", () => {
			assert.equal(didLatestAssistantAbort([{ role: "assistant", stopReason: "aborted" }]), true);
			assert.equal(
				didLatestAssistantAbort([
					{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" },
				]),
				true,
			);
			assert.equal(
				didLatestAssistantAbort([
					{ role: "assistant", stopReason: "error", errorMessage: "Request was aborted by upstream" },
				]),
				false,
			);
			assert.equal(didLatestAssistantAbort([{ role: "assistant", stopReason: "stop" }]), false);
			assert.equal(didLatestAssistantAbort(undefined), false);
		});

		it("stays open when the latest turn ended with stopReason=error", () => {
			// Provider failures (retry exhaustion, overload) must NOT auto-exit: the
			// pane stays open so the user can see the worker broke and inspect it.
			// The error sidecar (written separately by the agent_end handler) still
			// notifies the parent.
			const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
		});
	});

	describe("findLatestAssistantError", () => {
		it("returns the error info from a stopReason=error message", () => {
			const messages = [
				{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
				{ role: "toolResult", content: [] },
				{ role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
			];
			assert.deepEqual(findLatestAssistantError(messages), {
				errorMessage: "Anthropic 529 Overloaded",
				stopReason: "error",
			});
		});

		it("returns null when the latest assistant turn completed normally", () => {
			const messages = [
				{ role: "assistant", stopReason: "error", errorMessage: "old failure" },
				{ role: "user", content: [] },
				{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
			];
			assert.equal(findLatestAssistantError(messages), null);
		});

		it("returns null when the latest assistant turn was aborted by the user", () => {
			const messages = [{ role: "assistant", stopReason: "aborted" }];
			assert.equal(findLatestAssistantError(messages), null);
		});

		it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
			const messages = [{ role: "assistant", stopReason: "error" }];
			const info = findLatestAssistantError(messages);
			assert.ok(info);
			assert.equal(info?.stopReason, "error");
			assert.match(info?.errorMessage, /stopReason=error/);
		});

		it("returns null when messages is undefined or empty", () => {
			assert.equal(findLatestAssistantError(undefined), null);
			assert.equal(findLatestAssistantError([]), null);
		});
	});

	describe("buildCompletionSidecar", () => {
		it("emits done immediately for a normal auto-exit completion", () => {
			assert.deepEqual(
				buildCompletionSidecar([
					{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
				]),
				{ type: "done" },
			);
		});

		it("preserves provider errors in the immediate completion sidecar", () => {
			assert.deepEqual(
				buildCompletionSidecar([{ role: "assistant", stopReason: "error", errorMessage: "provider failed" }]),
				{
					type: "error",
					errorMessage: "provider failed",
					stopReason: "error",
				},
			);
		});
	});
});

describe("lifecycle.ts", () => {
	const activity = (overrides: Record<string, unknown> = {}) => ({
		version: 1 as const,
		runningChildId: "child",
		createdAt: 1_000,
		updatedAt: 2_000,
		sequence: 1,
		latestEvent: "agent_start" as const,
		phase: "active" as const,
		agentActive: true,
		turnActive: true,
		providerActive: false,
		toolActive: false,
		activeScope: "agent" as const,
		activeSince: 2_000,
		...overrides,
	});

	function interruptedLifecycle(activityOverrides: Record<string, unknown> = {}) {
		let lifecycle = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{
				ok: true,
				activity: activity({
					latestEvent: "agent_interrupted",
					phase: "waiting",
					agentActive: false,
					turnActive: false,
					activeScope: undefined,
					activeSince: undefined,
					updatedAt: 3_000,
					sequence: 2,
					interruptedAt: 3_000,
					interruptedSequence: 2,
					...activityOverrides,
				}),
			},
			3_100,
		);
		return lifecycle;
	}

	it("interrupts only the turn and keeps process runtime open", () => {
		const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
		const interrupted = markInterruptRequested(running, 3_000);
		const projection = projectLifecycle(interrupted, 8_000);
		assert.equal(interrupted.process.kind, "running");
		assert.equal(interrupted.turn.kind, "interrupted");
		assert.equal(projection.runtimeEndedAt, undefined);
	});

	it("rejects stale activity after interrupt and accepts a newer sequence", () => {
		const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
		const interrupted = markInterruptRequested(running, 3_000);
		const stale = observeLifecycleActivity(
			interrupted,
			{ ok: true, activity: activity({ updatedAt: 3_000 }) },
			3_100,
		);
		assert.equal(stale.turn.kind, "interrupted");
		const resumed = observeLifecycleActivity(
			stale,
			{
				ok: true,
				activity: activity({ updatedAt: 3_000, sequence: 2, activeSince: 3_000 }),
			},
			3_100,
		);
		assert.equal(resumed.turn.kind, "active");
	});

	it("projects child aborted activity as interrupted until a newer child turn begins", () => {
		let lifecycle = interruptedLifecycle({ waitingSince: 3_000 });
		assert.equal(projectLifecycle(lifecycle, 3_200).kind, "interrupted");

		lifecycle = observeLifecycleActivity(
			lifecycle,
			{
				ok: true,
				activity: activity({
					updatedAt: 4_000,
					sequence: 3,
					activeSince: 4_000,
					interruptedAt: undefined,
					interruptedSequence: undefined,
				}),
			},
			4_100,
		);
		assert.equal(projectLifecycle(lifecycle, 4_200).kind, "active");
	});

	it("clears interruption after a newer marker-free completion snapshot", () => {
		let lifecycle = interruptedLifecycle();
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{
				ok: true,
				activity: activity({
					latestEvent: "subagent_done",
					phase: "done",
					agentActive: false,
					turnActive: false,
					activeScope: undefined,
					activeSince: undefined,
					updatedAt: 4_000,
					sequence: 3,
					interruptedAt: undefined,
					interruptedSequence: undefined,
				}),
			},
			4_100,
		);
		assert.equal(projectLifecycle(lifecycle, 4_200).kind, "waiting");
	});

	it("makes finalizing and terminal process states irreversible", () => {
		const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
		const finalizing = markCompletionDetected(running, { reason: "done", exitCode: 0 }, 4_000);
		const ignored = observeLifecycleActivity(
			finalizing,
			{
				ok: true,
				activity: activity({ updatedAt: 5_000, sequence: 9 }),
			},
			5_000,
		);
		assert.equal(ignored.process.kind, "finalizing");
		assert.deepEqual(projectLifecycle(ignored, 9_000), { kind: "finalizing", runtimeEndedAt: 4_000 });
		const completed = markCompleted(ignored, 6_000);
		assert.equal(markFailed(completed, "late failure", 7_000).process.kind, "completed");
	});

	it("projects confirmed running without turn detail as running, not starting", () => {
		const started = createLifecycle(1_000);
		const running = {
			...started,
			process: { kind: "running" as const, startedAt: 1_000, confirmedAt: 1_500 },
		};
		assert.deepEqual(projectLifecycle(running, 3_000), { kind: "running" });
	});

	it("detects stalled and recovered transitions from lifecycle projections", () => {
		assert.equal(lifecycleTransition("active", "stalled"), "stalled");
		assert.equal(lifecycleTransition("stalled", "waiting"), "recovered");
		assert.equal(lifecycleTransition("stalled", "active"), "recovered");
		assert.equal(lifecycleTransition("stalled", "blocked"), "recovered");
		assert.equal(lifecycleTransition("stalled", "interrupted"), "recovered");
		assert.equal(lifecycleTransition("waiting", "active"), null);
	});

	it("does not interpret initial idle as completion", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "idle" },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 3_000).kind, "starting");
		assert.equal(lifecycle.turn.kind, "starting");
	});

	it("treats working then idle as waiting", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 2_500).kind, "active");
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "idle" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
	});

	it("preserves state entry time across repeated herdr observations", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "working" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).stateDurationSince, 2_000);

		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 5_000, agentStatus: "blocked" },
			5_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 6_000, agentStatus: "blocked" },
			6_000,
		);
		assert.equal(projectLifecycle(lifecycle, 7_000).stateDurationSince, 5_000);

		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 8_000, agentStatus: "idle" },
			8_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 9_000, agentStatus: "done" },
			9_000,
		);
		assert.equal(projectLifecycle(lifecycle, 10_000).stateDurationSince, 8_000);
	});

	it("does not enter finalizing from herdr idle/done", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "done" },
			3_000,
		);
		assert.equal(lifecycle.process.kind, "running");
		assert.notEqual(projectLifecycle(lifecycle, 4_000).kind, "finalizing");
	});

	it("projects blocked when herdr reports blocked", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "blocked" },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 3_000).kind, "blocked");
	});

	it("treats missing pane as pane observation but not immediate failure", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(lifecycle, { kind: "missing", error: "pane_not_found" }, 3_000);
		assert.equal(lifecycle.pane.kind, "missing");
		assert.equal(lifecycle.process.kind, "running");
	});

	it("preserves local interrupt over stale herdr statuses", () => {
		for (const agentStatus of ["working", "blocked", "idle", "done"] as const) {
			let lifecycle = createLifecycle(1_000);
			lifecycle = observePaneInspection(
				lifecycle,
				{ kind: "present", observedAt: 2_000, agentStatus: "working" },
				2_000,
			);
			lifecycle = markInterruptRequested(lifecycle, 3_000);
			lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_100, agentStatus }, 3_100);
			assert.equal(projectLifecycle(lifecycle, 4_000).kind, "interrupted", agentStatus);
		}
	});

	it("preserves hasWorked across unavailable observations", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(lifecycle, { kind: "unavailable", error: "socket" }, 2_500);
		lifecycle = observePaneInspection(lifecycle, { kind: "unavailable", error: "socket" }, 2_600);
		assert.equal(lifecycle.pane.kind, "read-error");
		assert.equal(lifecycle.pane.kind === "read-error" ? lifecycle.pane.consecutiveFailures : 0, 2);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "idle" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
	});

	it("does not let missing activity detail stall healthy herdr working", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observeLifecycleActivity(lifecycle, { ok: false, reason: "missing" }, 3_000);
		assert.equal(projectLifecycle(lifecycle, 120_000).kind, "active");
	});

	it("uses activity only as detail and does not override herdr waiting", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "idle" },
			3_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{ ok: true, activity: activity({ updatedAt: 3_100, sequence: 2 }) },
			3_100,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
	});

	it("preserves activity detail duration across repeated updates", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{
				ok: true,
				activity: activity({
					updatedAt: 2_100,
					sequence: 1,
					activeSince: 2_000,
					activeScope: "tool",
					toolName: "bash",
					toolStartedAt: 2_000,
				}),
			},
			2_100,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{
				ok: true,
				activity: activity({
					updatedAt: 3_000,
					sequence: 2,
					activeSince: 2_000,
					activeScope: "tool",
					toolName: "bash",
					toolStartedAt: 2_000,
				}),
			},
			3_000,
		);
		const projection = projectLifecycle(lifecycle, 4_000);
		assert.equal(projection.kind, "active");
		assert.equal(projection.label, "bash");
		assert.equal(projection.stateDurationSince, 2_000);
	});
});

describe("completion.ts", () => {
	it("decodes done payloads", () => {
		assert.deepEqual(interpretExitSidecar({ type: "done" }), {
			reason: "done",
			exitCode: 0,
		});
	});

	it("decodes error payloads and propagates the message with a non-zero exit code", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "error",
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
				stopReason: "error",
			}),
			{
				reason: "error",
				exitCode: 1,
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
			},
		);
	});

	it("falls back to a placeholder when error payload has no errorMessage", () => {
		const result = interpretExitSidecar({ type: "error" });
		assert.equal(result.reason, "error");
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /no errorMessage/);
	});

	it("rejects the removed legacy ping sidecar", () => {
		const result = interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" });
		assert.equal(result.reason, "error");
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /Invalid subagent completion sidecar/);
	});

	it("rejects unknown completion sidecar payloads", () => {
		for (const payload of [{}, null]) {
			const result = interpretExitSidecar(payload);
			assert.equal(result.reason, "error");
			assert.equal(result.exitCode, 1);
			assert.match(result.errorMessage ?? "", /Invalid subagent completion sidecar/);
		}
	});

	it("surfaces a current-run sidecar with an unsupported payload instead of discarding it", async () => {
		// Regression: interpretExitSidecar omitted runId from its unsupported-payload
		// result, so consumeExitSidecar's ownership check saw runId === undefined,
		// deleted the artifact, and returned null — a current-run malformed sidecar
		// vanished and the watch ran to its deadline instead of settling visibly.
		const dir = mkdtempSync(join(tmpdir(), "completion-sidecar-own-"));
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(sessionFile, "");
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "mystery", runId: "run-current" }));
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				expectedRunId: "run-current",
				readTerminalTail: async () => "",
			});
			assert.equal(result.reason, "error", "a current-run unsupported sidecar is a visible error");
			assert.equal(result.exitCode, 1);
			assert.match(result.errorMessage ?? "", /Invalid subagent completion sidecar/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still discards a stale sidecar owned by a different run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-sidecar-stale-"));
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(sessionFile, "");
		// Owned by an older run: must be ignored for THIS run, not surface its error.
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done", runId: "run-old" }));
		try {
			const controller = new AbortController();
			const result = await waitForCompletion(controller.signal, {
				intervalMs: 5,
				sessionFile,
				expectedRunId: "run-current",
				readTerminalTail: async () => "__SUBAGENT_DONE_0__", // this run's real evidence
				timeoutMs: 500,
			});
			assert.equal(result.reason, "sentinel", "the stale sidecar is ignored in favour of real evidence");
			assert.equal(result.exitCode, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("consumes a sidecar and removes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-sidecar-"));
		const sessionFile = join(dir, "session.jsonl");
		const exitFile = `${sessionFile}.exit`;
		writeFileSync(exitFile, JSON.stringify({ type: "done" }));
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
			});
			assert.deepEqual(result, {
				reason: "done",
				exitCode: 0,
			});
			assert.equal(existsSync(exitFile), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("discards stale sidecars without treating them as the current run's failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-owned-sidecar-"));
		const sessionFile = join(dir, "session.json");
		const exitFile = `${sessionFile}.exit`;
		try {
			writeFileSync(exitFile, JSON.stringify({ type: "done", runId: "old-run" }));
			await assert.rejects(
				waitForCompletion(AbortSignal.timeout(30), {
					intervalMs: 1,
					sessionFile,
					expectedRunId: "new-run",
					readTerminalTail: async () => "",
				}),
				/Aborted while waiting for subagent to finish/,
			);
			assert.equal(existsSync(exitFile), false);
			writeFileSync(exitFile, "{not json");
			const malformed = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				expectedRunId: "new-run",
				readTerminalTail: async () => "",
			});
			assert.equal(malformed.exitCode, 1);
			assert.match(malformed.errorMessage ?? "", /Malformed/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the terminal sentinel exit code", async () => {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => "output\n__SUBAGENT_DONE_17__\n",
		});
		assert.deepEqual(result, { reason: "sentinel", exitCode: 17 });
	});

	it("returns when an external sentinel file appears", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-sentinel-"));
		const sentinelFile = join(dir, "done");
		writeFileSync(sentinelFile, "complete");
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sentinelFile,
				readTerminalTail: async () => "",
			});
			assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries transient terminal read failures and reports ticks", async () => {
		let reads = 0;
		let ticks = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("pane temporarily unavailable");
				return "__SUBAGENT_DONE_0__";
			},
			onTick: () => {
				ticks += 1;
			},
		});
		assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
		assert.equal(reads, 2);
		assert.equal(ticks, 1);
	});

	it("returns a failure when the pane explicitly disappears", async () => {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				throw new Error("pane read failed");
			},
			inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
			paneDisappearanceGraceMs: 0,
		});
		assert.deepEqual(result, {
			reason: "error",
			exitCode: 1,
			errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
		});
	});

	it("lets a sidecar win the pane-disappearance race", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-race-"));
		const sessionFile = join(dir, "child.jsonl");
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
				inspectPane: async () => {
					writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
					return { kind: "missing", error: "pane_not_found" };
				},
			});
			assert.deepEqual(result, { reason: "done", exitCode: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("waits briefly for delayed sidecar publication after pane disappearance", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-delayed-race-"));
		const sessionFile = join(dir, "child.jsonl");
		const timer = setTimeout(() => {
			writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
		}, 30);
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
				inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
				paneDisappearanceGraceMs: 150,
			});
			assert.deepEqual(result, { reason: "done", exitCode: 0 });
		} finally {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps an ambiguous pane read failure retryable while the pane exists", async () => {
		let reads = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("socket unavailable");
				return "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => ({ kind: "present", observedAt: 0, agentStatus: "working" }),
		});
		assert.equal(result.exitCode, 0);
		assert.equal(reads, 2);
	});

	it("treats presence-check throws as unknown and keeps polling", async () => {
		let reads = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("pane read failed");
				return "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => {
				throw new Error("herdr list failed");
			},
		});
		assert.equal(result.exitCode, 0);
		assert.equal(reads, 2);
	});

	it("detects pane disappearance even when terminal reads hang forever", async () => {
		// Gap 2 fix: inspectPane runs BEFORE readTerminalTail so a hung terminal
		// read cannot strand the watcher. A missing pane must be detected
		// regardless of whether readTerminalTail ever resolves.
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: () =>
				new Promise<string>(() => {
					/* never resolves */
				}),
			inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
			paneDisappearanceGraceMs: 0,
		});
		assert.deepEqual(result, {
			reason: "error",
			exitCode: 1,
			errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
		});
	});

	it("inspects herdr status even when terminal reads succeed", async () => {
		let reads = 0;
		const inspections: string[] = [];
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				return reads === 1 ? "shell output" : "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => ({ kind: "present", observedAt: 2_000, agentStatus: "blocked" }),
			onPaneInspection: (inspection) =>
				inspections.push(inspection.kind === "present" ? inspection.agentStatus : inspection.kind),
		});
		assert.equal(result.exitCode, 0);
		// inspectPane now runs BEFORE readTerminalTail on each poll, so the pane
		// is inspected on both the first poll (terminal returns "shell output")
		// and the second poll (terminal returns the sentinel).
		assert.deepEqual(inspections, ["blocked", "blocked"]);
	});

	it("rejects promptly when aborted", async () => {
		const controller = new AbortController();
		const completion = waitForCompletion(controller.signal, {
			intervalMs: 10_000,
			readTerminalTail: async () => "",
		});
		controller.abort();
		await assert.rejects(completion, /Aborted while waiting for subagent to finish/);
	});
});

describe("commands", () => {
	it("registers no slash commands", () => {
		const { api, registeredCommands } = createMockExtensionApi();
		(subagentsModule as any).default(api);
		assert.deepEqual(
			registeredCommands.map((command) => command.name),
			[],
			"pi-subagent-herdr must not register /iterate, /subagent, or /plan",
		);
	});
});

describe("spawn defaults", () => {
	it("resolves blocking: per-call overrides hard-coded background default", () => {
		const testApi = (subagentsModule as any).__test__;
		assert.equal(testApi.resolveBlocking({} as any), false);
		assert.equal(testApi.resolveBlocking({} as any, testApi.EXTENSION_DEFAULTS), false);
		assert.equal(testApi.resolveBlocking({} as any, { blocking: true }), true);
		assert.equal(testApi.resolveBlocking({ blocking: true } as any, { blocking: false }), true);
		assert.equal(testApi.resolveBlocking({ blocking: false } as any, { blocking: true }), false);
	});

	it("resolves omitted layout/surface/direction to attached/pane/right", () => {
		const testApi = (subagentsModule as any).__test__;
		assert.equal(testApi.resolveLayout({}), "attached");
		assert.equal(testApi.resolveSurface({}), "pane");
		assert.equal(testApi.resolveDirection({}), "right");
		assert.deepEqual(testApi.EXTENSION_DEFAULTS, {
			blocking: false,
			layout: "attached",
			surface: "pane",
			direction: "right",
		});
	});

	it("prefers per-call layout trio over defaults", () => {
		const testApi = (subagentsModule as any).__test__;
		assert.equal(testApi.resolveLayout({ layout: "single" }), "single");
		assert.equal(testApi.resolveSurface({ surface: "tab" }), "tab");
		assert.equal(testApi.resolveDirection({ direction: "down" }), "down");
	});

	it("describes named always-visible auto-exiting runs", () => {
		const { api, registeredTools } = createMockExtensionApi();
		(subagentsModule as any).default(api);
		const subagent = registeredTools.find((tool) => tool.name === "subagent");
		assert.ok(subagent);
		assert.match(subagent.description, /blocking/i);
		assert.match(subagent.description, /auto-exits/i);
		assert.match(subagent.promptSnippet, /real surface/i);
	});

	it("renders blocking completed outcome", () => {
		const { api, registeredTools } = createMockExtensionApi();
		(subagentsModule as any).default(api);
		const subagent = registeredTools.find((tool) => tool.name === "subagent");
		const theme = { fg: (_k: string, t: string) => t, bg: (_k: string, t: string) => t, bold: (t: string) => t };
		const completed = subagent.renderResult(
			{
				content: [{ type: "text", text: "all done" }],
				details: { name: "Worker", status: "completed", blocking: true, agent: "worker", id: "a".repeat(32) },
			},
			{},
			theme,
		);
		const rendered = typeof completed?.render === "function" ? completed.render(80).join("\n") : String(completed);
		assert.match(rendered, /Worker|completed/i);
		assert.match(rendered, /\[a{32}\]/);
	});

	it("cancelled blocking results remain explicit failures with a session log", () => {
		const presentation = (subagentsModule as any).__test__.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 3,
				summary: "Subagent cancelled.",
				sessionFile: "/tmp/subagent-cancel.jsonl",
			},
			"Worker",
			"run-1234",
		);
		assert.match(presentation, /failed \(exit code 1\)/);
		assert.match(presentation, /\[run-1234\]/);
		assert.match(presentation, /Session log: \/tmp\/subagent-cancel\.jsonl/);
	});
});

describe("tool registration", () => {
	it("registers only subagent in the parent", () => {
		delete process.env.PI_SUBAGENT_ID;
		const { api, registeredTools } = createMockExtensionApi();
		(subagentsModule as any).default(api);
		assert.deepEqual(registeredTools.map((tool) => tool.name).sort(), ["subagent"]);
	});

	it("registers no parent lifecycle tools in a child regardless of permission env", () => {
		process.env.PI_SUBAGENT_ID = "child-test";
		process.env.PI_DENY_TOOLS = "";
		try {
			const { api, registeredTools } = createMockExtensionApi();
			(subagentsModule as any).default(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent"),
				false,
			);
		} finally {
			delete process.env.PI_SUBAGENT_ID;
			delete process.env.PI_DENY_TOOLS;
		}
	});

	it("renders partial strict subagent args without throwing", () => {
		const { api, registeredTools } = createMockExtensionApi();
		(subagentsModule as any).default(api);
		const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const output = subagentTool.renderCall({}, theme).render(80).join("\n");
		assert.match(output, /agent required/);
	});
});

describe("subagent parent lifecycle", () => {
	it("preserves active subagents during extension reload", () => {
		const abortController = new AbortController();
		const agents = new Map([
			[
				"child",
				{
					abortController,
					lifecycle: createLifecycle(1_000),
				},
			],
		]);

		cleanupSubagentsForShutdown("reload", agents);

		assert.equal(shouldPreserveSubagentsOnShutdown("reload"), true);
		assert.equal(abortController.signal.aborted, false);
		const child = agents.get("child");
		assert.ok(child);
		assert.equal(shouldDeliverSubagentCompletion(child), true);
		assert.equal(agents.size, 1);
	});

	it("aborts and clears active subagents during final shutdown", () => {
		for (const reason of ["quit", "new", "resume", "fork", undefined]) {
			const abortController = new AbortController();
			const running = { abortController, lifecycle: createLifecycle(1_000) };
			const agents = new Map([["child", running]]);

			cleanupSubagentsForShutdown(reason, agents);

			assert.equal(shouldPreserveSubagentsOnShutdown(reason), false);
			assert.equal(abortController.signal.aborted, true);
			// Delivery is suppressed before the map is cleared so a racing watcher
			// that still holds a reference cannot deliver after shutdown.
			assert.equal(running.lifecycle.delivery, "suppressed");
			assert.equal(shouldDeliverSubagentCompletion(running), false);
			assert.equal(agents.size, 0);
		}
	});

	it("treats lifecycle.delivery as the authoritative completion gate", () => {
		const pending = { lifecycle: createLifecycle(1_000) };
		assert.equal(shouldDeliverSubagentCompletion(pending), true);

		const delivered = {
			lifecycle: { ...createLifecycle(1_000), delivery: "delivered" as const },
		};
		assert.equal(shouldDeliverSubagentCompletion(delivered), false);

		const suppressed = {
			lifecycle: { ...createLifecycle(1_000), delivery: "suppressed" as const },
		};
		assert.equal(shouldDeliverSubagentCompletion(suppressed), false);

		// Pre-lifecycle fixtures without a lifecycle field still default to pending.
		assert.equal(shouldDeliverSubagentCompletion({} as any), true);
	});

	it("final shutdown revokes queue, starting transactions, pending delivery, and active ownership", () => {
		const parentId = `shutdown-${Date.now()}-${Math.random()}`;
		let queuedCancelled = 0;
		let closed = 0;
		let released = 0;
		let transactionsAborted = 0;
		const abortController = new AbortController();
		const queued = new Map([
			[
				"queued",
				{
					id: "queued",
					name: "q",
					agent: "a",
					admissionClass: "background" as const,
					queuedAt: Date.now(),
					cancel: () => {
						queuedCancelled++;
						return true;
					},
				},
			],
		]);
		const running = new Map([
			[
				"running",
				{
					id: "running",
					name: "r",
					task: "t",
					surface: "pane",
					startTime: Date.now(),
					sessionFile: "/tmp/running.jsonl",
					admissionClass: "background",
					abortController,
					lifecycle: createLifecycle(Date.now()),
					runtimePlan: undefined,
				} as any,
			],
		]);
		const pending = new Map([["pending", { id: "pending" } as any]]);

		settleParentShutdown(
			"quit",
			parentId,
			{ queued, running, pending },
			{
				safeClose: () => {
					closed++;
				},
				release: () => {
					released++;
				},
				abortTransactions: () => {
					transactionsAborted++;
				},
			},
		);

		assert.equal(queuedCancelled, 1);
		assert.equal(queued.size, 0);
		assert.equal(pending.size, 0);
		assert.equal(running.size, 0);
		assert.equal(closed, 1);
		assert.equal(released, 1);
		assert.equal(transactionsAborted, 1);
		assert.equal(abortController.signal.aborted, true);
	});

	it("reload reaps foreground ownership while preserving background", () => {
		const parentId = `reload-${Date.now()}-${Math.random()}`;
		let foregroundCancelled = 0;
		const queued = new Map<string, any>([
			[
				"foreground",
				{
					id: "foreground",
					admissionClass: "foreground",
					cancel: () => {
						foregroundCancelled++;
						return true;
					},
				},
			],
			["background", { id: "background", admissionClass: "background", cancel: () => true }],
		]);
		const fgAbort = new AbortController();
		const running = new Map<string, any>([
			[
				"fg",
				{
					id: "fg",
					admissionClass: "foreground",
					abortController: fgAbort,
					lifecycle: createLifecycle(Date.now()),
				},
			],
			["bg", { id: "bg", admissionClass: "background", lifecycle: createLifecycle(Date.now()) }],
		]);
		settleParentShutdown(
			"reload",
			parentId,
			{ queued, running, pending: new Map() },
			{
				safeClose: () => {},
				release: () => {},
			},
		);
		assert.equal(foregroundCancelled, 1);
		assert.deepEqual(Array.from(queued.keys()), ["background"]);
		assert.deepEqual(Array.from(running.keys()), ["bg"]);
		assert.equal(fgAbort.signal.aborted, true);
	});

	it("delivers completion through the reloaded extension API", () => {
		// The active completion runtime is the only delivery API: a captured
		// (stale) factory API is never a fallback after reload or replacement.
		const testApi = (subagentsModule as any).__test__;
		const previous: any = { id: "previous" };
		const current: any = { id: "current" };
		const sessionId = `reload-affinity-${Date.now()}-${Math.random()}`;
		testApi.resetActiveCompletionRuntime();
		try {
			assert.throws(
				() => testApi.requireActiveCompletionRuntime(sessionId),
				(error: unknown) => testApi.isSessionRuntimeUnavailable(error),
				"no active record → typed unavailable condition, never a stale fallback",
			);
			testApi.activateCompletionRuntime(previous, sessionId);
			assert.equal(testApi.requireActiveCompletionRuntime(sessionId).api, previous);
			// A replacement session_start rebinds the SAME session to the new API.
			testApi.activateCompletionRuntime(current, sessionId);
			assert.equal(testApi.requireActiveCompletionRuntime(sessionId).api, current);
			// A different session never resolves another session's record.
			assert.throws(
				() => testApi.requireActiveCompletionRuntime(`other-${sessionId}`),
				(error: unknown) => testApi.isSessionRuntimeUnavailable(error),
			);
		} finally {
			testApi.resetActiveCompletionRuntime();
		}
	});
});

describe("subagent activity snapshots", () => {
	function validActivity(overrides: Record<string, unknown> = {}) {
		return {
			version: 1,
			runningChildId: "child-1",
			createdAt: 1_000,
			updatedAt: 1_000,
			sequence: 1,
			latestEvent: "session_start",
			phase: "starting",
			agentActive: false,
			turnActive: false,
			providerActive: false,
			toolActive: false,
			...overrides,
		};
	}

	it("writes and validates activity files by running child id", () => {
		withTempDir((dir) => {
			const activityFile = getSubagentActivityFile(dir, "child-1");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-1",
				activityFile,
				now: () => 1_000,
			});

			recorder.sessionStart();
			recorder.toolExecutionStart("tool-1", "bash");

			const read = readSubagentActivityFile(activityFile, "child-1");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "active");
			assert.equal(read.activity.activeScope, "tool");
			assert.equal(read.activity.toolName, "bash");

			assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
				ok: false,
				reason: "wrong-id",
			});
		});
	});

	it("records waiting and final done states", () => {
		withTempDir((dir) => {
			let currentNow = 2_000;
			const activityFile = getSubagentActivityFile(dir, "child-2");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-2",
				activityFile,
				now: () => currentNow,
			});

			recorder.sessionStart();
			currentNow = 3_000;
			recorder.agentEndWaiting();
			let read = readSubagentActivityFile(activityFile, "child-2");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "waiting");
			assert.equal(read.activity.waitingSince, 3_000);

			currentNow = 4_000;
			recorder.subagentDone();
			read = readSubagentActivityFile(activityFile, "child-2");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "done");
			assert.equal(read.activity.agentActive, false);
		});
	});

	it("rejects malformed activity fields used by classification and rendering", () => {
		withTempDir((dir) => {
			mkdirSync(join(dir, "subagent-activity"), { recursive: true });
			const cases = [
				{ activeSince: "bad" },
				{ waitingSince: "bad" },
				{ activeScope: "database" },
				{ latestEvent: "unknown" },
				{ runningChildId: 42 },
				{ toolActive: "yes" },
				{ toolName: "bad\nname" },
			];

			for (const [index, overrides] of cases.entries()) {
				const activityFile = getSubagentActivityFile(dir, `child-${index}`);
				const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
				writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

				const read = readSubagentActivityFile(activityFile, `child-${index}`);
				assert.equal(read.ok, false);
				assert.equal((read as { ok: false; reason: string }).reason, "invalid");
			}
		});
	});

	it("does not let tool_result resurrect finished tool activity", () => {
		withTempDir((dir) => {
			let currentNow = 1_000;
			const activityFile = getSubagentActivityFile(dir, "child-3");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-3",
				activityFile,
				now: () => currentNow,
			});

			recorder.sessionStart();
			recorder.agentStart();
			recorder.turnStart(1);
			currentNow = 2_000;
			recorder.toolExecutionStart("tool-1", "bash");
			currentNow = 3_000;
			recorder.toolExecutionEnd("tool-1", "bash");
			currentNow = 4_000;
			recorder.toolResult("tool-1", "bash");

			const read = readSubagentActivityFile(activityFile, "child-3");
			assert.ok(read.ok);
			assert.equal(read.activity.toolActive, false);
			assert.equal(read.activity.activeScope, "turn");
		});
	});

	it("does not mark reload shutdown as the final done snapshot", () => {
		withTempDir((dir) => {
			const activityFile = getSubagentActivityFile(dir, "child-4");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-4",
				activityFile,
				now: () => 1_000,
			});

			recorder.sessionStart();
			recorder.sessionShutdown("reload");

			const read = readSubagentActivityFile(activityFile, "child-4");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "starting");
			assert.equal(read.activity.latestEvent, "session_start");
		});
	});

	it("cancels pending throttled writes on reload shutdown", async () => {
		const dir = createTestDir();
		try {
			await new Promise<void>((resolve) => {
				let currentNow = 1_000;
				const activityFile = getSubagentActivityFile(dir, "child-5");
				const recorder = createSubagentActivityRecorder({
					runningChildId: "child-5",
					activityFile,
					now: () => currentNow,
				});

				recorder.sessionStart();
				currentNow = 1_100;
				recorder.messageUpdate("delta");
				recorder.sessionShutdown("reload");

				setTimeout(() => {
					const read = readSubagentActivityFile(activityFile, "child-5");
					assert.ok(read.ok);
					assert.equal(read.activity.phase, "starting");
					assert.equal(read.activity.latestEvent, "session_start");
					resolve();
				}, 650);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves activity sequence across reload so post-reload interruption and direct continuation stay fresh", () => {
		withTempDir((dir) => {
			let currentNow = 1_000;
			const activityFile = getSubagentActivityFile(dir, "child-reload");
			const first = createSubagentActivityRecorder({
				runningChildId: "child-reload",
				activityFile,
				now: () => currentNow,
			});
			first.sessionStart();
			currentNow = 2_000;
			first.agentStart();

			const activeBeforeReload = readSubagentActivityFile(activityFile, "child-reload");
			assert.ok(activeBeforeReload.ok);
			if (!activeBeforeReload.ok) return;
			let lifecycle = observeLifecycleActivity(createLifecycle(1_000), activeBeforeReload, 2_100);
			const preReloadSequence = activeBeforeReload.activity.sequence;

			first.sessionShutdown("reload");
			currentNow = 3_000;
			const reloaded = createSubagentActivityRecorder({
				runningChildId: "child-reload",
				activityFile,
				now: () => currentNow,
			});
			reloaded.sessionStart();
			currentNow = 4_000;
			reloaded.agentEndInterrupted();

			const interruptedRead = readSubagentActivityFile(activityFile, "child-reload");
			assert.ok(interruptedRead.ok);
			if (!interruptedRead.ok) return;
			assert.ok(interruptedRead.activity.sequence > preReloadSequence);
			lifecycle = observeLifecycleActivity(lifecycle, interruptedRead, 4_100);
			assert.equal(projectLifecycle(lifecycle, 4_200).kind, "interrupted");

			currentNow = 5_000;
			reloaded.agentStart();
			const continuedRead = readSubagentActivityFile(activityFile, "child-reload");
			assert.ok(continuedRead.ok);
			if (!continuedRead.ok) return;
			assert.ok(continuedRead.activity.sequence > interruptedRead.activity.sequence);
			lifecycle = observeLifecycleActivity(lifecycle, continuedRead, 5_100);
			assert.equal(projectLifecycle(lifecycle, 5_200).kind, "active");
		});
	});

	it("preserves an interruption marker through reload until newer child activity begins", () => {
		withTempDir((dir) => {
			let currentNow = 1_000;
			const activityFile = getSubagentActivityFile(dir, "child-interrupted-reload");
			const first = createSubagentActivityRecorder({
				runningChildId: "child-interrupted-reload",
				activityFile,
				now: () => currentNow,
			});
			first.sessionStart();
			currentNow = 2_000;
			first.agentEndInterrupted();
			const beforeReload = readSubagentActivityFile(activityFile, "child-interrupted-reload");
			assert.ok(beforeReload.ok);
			if (!beforeReload.ok) return;

			first.sessionShutdown("reload");
			currentNow = 3_000;
			const reloaded = createSubagentActivityRecorder({
				runningChildId: "child-interrupted-reload",
				activityFile,
				now: () => currentNow,
			});
			reloaded.sessionStart();
			const afterReload = readSubagentActivityFile(activityFile, "child-interrupted-reload");
			assert.ok(afterReload.ok);
			if (!afterReload.ok) return;
			assert.equal(afterReload.activity.interruptedAt, beforeReload.activity.interruptedAt);
			assert.equal(afterReload.activity.interruptedSequence, beforeReload.activity.interruptedSequence);
			const lifecycle = observeLifecycleActivity(createLifecycle(1_000), afterReload, 3_100);
			assert.equal(projectLifecycle(lifecycle, 3_200).kind, "interrupted");
		});
	});
});

describe("subagent result presentation", () => {
	it("formats exit code 130 as an ordinary failure", () => {
		const testApi = (subagentsModule as any).__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 130,
				elapsed: 61,
				summary: "Sub-agent exited with code 130",
				sessionFile: "/tmp/subagent.jsonl",
			},
			"Worker",
		);

		assert.match(presentation, /failed \(exit code 130\)/);
		assert.doesNotMatch(presentation, /interrupted/);
		assert.match(presentation, /Session log: \/tmp\/subagent\.jsonl/);
	});

	it("renders a clear provider/agent error when errorMessage is set", () => {
		// Previously, an overload retry-exhaustion produced exitCode 0 with a
		// stale summary — the orchestrator thought the subagent finished
		// quickly. With the error sidecar plumbed through, the presentation
		// must call out the failure, include the underlying error, and tell the
		// orchestrator how to recover.
		const testApi = (subagentsModule as any).__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 14,
				summary: "ignored when errorMessage is present",
				sessionFile: "/tmp/subagent.jsonl",
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
			},
			"Worker",
		);

		assert.match(presentation, /Sub-agent "Worker" failed/);
		assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
		assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
		assert.match(presentation, /Session log: \/tmp\/subagent\.jsonl/);
		assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
	});
});

describe("subagent status renderer", () => {
	function createTheme() {
		return {
			fg(_color: string, text: string) {
				return text;
			},
			bg(_color: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		};
	}

	function subagentStatusRenderer() {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		(subagentsModule as any).default(api);
		const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
		assert.ok(rendererEntry, "expected subagent_status renderer to be registered");
		return rendererEntry;
	}

	it("renders only capped lines plus overflow", () => {
		const rendererEntry = subagentStatusRenderer();

		const visibleLines = [
			"Worker running 5m, active (bash 2m).",
			"Scout running 3m, waiting 1m.",
			"Reviewer running 2m, active (streaming 30s).",
			"Planner running 4m, waiting 2m.",
		];
		const rendered = rendererEntry.renderer(
			{
				customType: "subagent_status",
				content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
				details: {
					lines: visibleLines,
					overflow: 2,
				},
			},
			{ expanded: true },
			createTheme(),
		);
		const output = rendered.render(80).join("\n");

		assert.match(output, /Subagent status/);
		for (const line of visibleLines) {
			assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
		assert.match(output, /\+2 more running\./);
	});

	it("stays within narrow widths", () => {
		const rendererEntry = subagentStatusRenderer();

		const rendered = rendererEntry.renderer(
			{
				customType: "subagent_status",
				content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
				details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
			},
			{ expanded: true },
			createTheme(),
		);

		for (const width of [4, 5, 6]) {
			for (const line of rendered.render(width)) {
				assert.ok(
					visibleWidth(line) <= width,
					`expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
				);
			}
		}
	});
});

describe("subagent startup delay", () => {
	it("defaults to 500ms when no env var is set", () => {
		const testApi = (subagentsModule as any).__test__;
		assert.ok(testApi, "expected subagents test helpers to be exported");
		assert.equal(typeof testApi.getShellReadyDelayMs, "function");

		const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
		delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
		try {
			assert.equal(testApi.getShellReadyDelayMs(), 500);
		} finally {
			if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
			else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
		}
	});

	it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
		const testApi = (subagentsModule as any).__test__;
		assert.ok(testApi, "expected subagents test helpers to be exported");
		assert.equal(typeof testApi.getShellReadyDelayMs, "function");

		const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
		process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
		try {
			assert.equal(testApi.getShellReadyDelayMs(), 2500);
		} finally {
			if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
			else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
		}
	});
});
describe("subagents widget rendering", () => {
	const theme = createTaggedWidgetTheme();

	it("shows interrupted agents as open while process runtime continues", () => {
		const testApi = (subagentsModule as any).__test__;
		const lifecycle = markInterruptRequested(
			{ ...createLifecycle(5_000), process: { kind: "running", startedAt: 5_000, confirmedAt: 5_000 } },
			20_000,
		);

		withMockedNow(30_000, () => {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "Worker",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "sess1",
						lifecycle,
					},
				],
				64,
				theme,
			);
			assert.match(lines[0], /1 open/);
			assert.match(lines[0], /tier:accent/);
			assert.match(lines[1], /■ Worker · \[a1\].*25s/);
			assert.match(lines[2], /interrupted 10s/);
			assert.doesNotMatch(lines.join("\n"), /running|active/);
		});
	});

	it("hydrates legacy activity done as waiting, not finalizing", () => {
		const testApi = (subagentsModule as any).__test__;
		const legacyDone = observeStatus(
			createStatusState({ source: "pi", startTimeMs: 5_000 }),
			{ snapshot: "present", updatedAt: 20_000, sequence: 1, phase: "done", latestEvent: "subagent_done" },
			20_000,
		);
		withMockedNow(30_000, () => {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "legacy",
						name: "Legacy",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "sess1",
						statusState: legacyDone,
					},
				],
				64,
				theme,
			);
			assert.match(lines[2], /waiting/);
			assert.doesNotMatch(lines[2], /finalizing/);
		});
	});

	it("freezes runtime when the subagent reports done", () => {
		const testApi = (subagentsModule as any).__test__;
		const lifecycle = markCompletionDetected(createLifecycle(5_000), { reason: "done", exitCode: 0 }, 20_000);
		withMockedNow(30_000, () => {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "Reviewer",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "sess1",
						lifecycle,
					},
				],
				64,
				theme,
			);
			assert.match(lines[0], /1 open/);
			assert.match(lines[1], /Reviewer · \[a1\].*15s/);
			assert.match(lines[2], /finalizing…/);
			assert.doesNotMatch(lines[1], /25s/);
		});
	});

	it("uses the theme accent and summarizes mixed active and open agents", () => {
		const testApi = (subagentsModule as any).__test__;
		const active = observeLifecycleActivity(
			createLifecycle(5_000),
			{
				ok: true,
				activity: {
					version: 1,
					runningChildId: "a1",
					createdAt: 5_000,
					updatedAt: 29_000,
					sequence: 1,
					latestEvent: "agent_start",
					phase: "active",
					agentActive: true,
					turnActive: true,
					providerActive: false,
					toolActive: false,
					activeScope: "agent",
					activeSince: 29_000,
				},
			},
			29_000,
		);
		const interrupted = markInterruptRequested(
			{ ...createLifecycle(10_000), process: { kind: "running", startedAt: 10_000, confirmedAt: 10_000 } },
			20_000,
		);
		withMockedNow(30_000, () => {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "Active",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "s1",
						lifecycle: active,
					},
					{
						id: "a2",
						name: "Open",
						task: "",
						surface: "s2",
						startTime: 10_000,
						sessionFile: "s2",
						lifecycle: interrupted,
					},
				],
				72,
				theme,
			);
			assert.match(lines[0], /1 active · 1 open/);
			assert.match(lines[0], /tier:accent/);
		});
	});

	it("shows queued class, stable run ID, and duplicate labels", () => {
		const testApi = (subagentsModule as any).__test__;
		const lines = testApi.renderSubagentWidgetLines([], 100, theme, [
			{
				id: "queue-a",
				name: "Review",
				agent: "reviewer",
				admissionClass: "foreground",
				queuedAt: Date.now(),
				cancel() {},
			},
			{
				id: "queue-b",
				name: "Review",
				agent: "reviewer",
				admissionClass: "background",
				queuedAt: Date.now(),
				cancel() {},
			},
		]);
		assert.match(lines[0], /2 queued/);
		assert.match(lines.join("\n"), /◷ Reviewer \[queue-a\] · foreground · queued/);
		assert.match(lines.join("\n"), /◷ Reviewer \[queue-b\] · background · queued/);
	});

	it("keeps every rendered line within a very narrow width", () => {
		const testApi = (subagentsModule as any).__test__;
		withMockedNow(1_000_000, () => {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "A",
						task: "",
						surface: "s1",
						startTime: 987_000,
						sessionFile: "sess1",
						lifecycle: createLifecycle(987_000),
					},
					{
						id: "a2",
						name: "B",
						task: "",
						surface: "s2",
						startTime: 979_000,
						sessionFile: "sess2",
						lifecycle: createLifecycle(979_000),
					},
					{
						id: "a3",
						name: "C",
						task: "",
						surface: "s3",
						startTime: 973_000,
						sessionFile: "sess3",
						lifecycle: createLifecycle(973_000),
					},
				],
				16,
				theme,
			);
			for (const line of lines) assert.ok(visibleWidth(line) <= 16);
		});
	});

	it("handles ultra-narrow widths without exceeding the width contract", () => {
		const testApi = (subagentsModule as any).__test__;
		for (const width of [0, 1, 2]) {
			const startTime = Date.now() - 5_000;
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "A",
						task: "",
						surface: "s1",
						startTime,
						sessionFile: "sess1",
						lifecycle: createLifecycle(startTime),
					},
				],
				width,
				theme,
			);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
				);
			}
		}
	});
});

describe("herdr.ts", () => {
	describe("isHerdrAvailable", () => {
		it("returns boolean based on HERDR_ENV", () => {
			const result = isHerdrAvailable();
			assert.equal(typeof result, "boolean");
		});
	});

	describe("herdr command construction", () => {
		it("targets the current workspace when creating a subagent tab", () => {
			assert.deepEqual(__herdrTest__.buildTabCreateArgs("reviewer", "/repo", "workspace-2"), [
				"tab",
				"create",
				"--workspace",
				"workspace-2",
				"--label",
				"reviewer",
				"--cwd",
				"/repo",
				"--no-focus",
			]);
		});
	});

	describe("herdr response parsing", () => {
		it("extracts pane id from a pane split response", () => {
			const output = JSON.stringify({
				result: {
					pane: {
						pane_id: "1-3",
						tab_id: "1:2",
						workspace_id: "1",
					},
				},
			});
			assert.equal(__herdrTest__.extractHerdrPaneId(output, "pane split"), "1-3");
		});

		it("extracts root pane id from a tab create response", () => {
			const output = JSON.stringify({
				result: {
					tab: { tab_id: "1:2" },
					root_pane: { pane_id: "1-2" },
				},
			});
			assert.equal(__herdrTest__.extractHerdrRootPaneId(output, "tab create"), "1-2");
		});

		it("throws on malformed herdr JSON", () => {
			assert.throws(
				() => __herdrTest__.extractHerdrPaneId("not json", "pane split"),
				/Unexpected herdr pane split output/,
			);
		});

		it("parses pane-not-found JSON from stderr-shaped errors", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane gone" } }),
				stdout: "",
			});
			assert.deepEqual(result, { kind: "missing", error: "pane gone" });
		});

		it("continues from non-JSON stderr to structured stdout", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: "warning: connection closed",
				stdout: JSON.stringify({ error: { code: "pane_not_found", message: "pane gone" } }),
			});
			assert.deepEqual(result, { kind: "missing", error: "pane gone" });
		});

		it("returns unavailable when both error streams are non-JSON", () => {
			const result = __herdrTest__.parsePaneGetError({
				message: "command failed",
				stderr: "warning: connection closed",
				stdout: "not json either",
			});
			assert.deepEqual(result, { kind: "unavailable", error: "command failed" });
		});

		it("recognizes plain-text pane_not_found on stderr", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: "pane_not_found: pane w1:p1 not found",
				stdout: "unrelated output",
			});
			assert.deepEqual(result, {
				kind: "missing",
				error: "pane_not_found: pane w1:p1 not found",
			});
		});

		it("recognizes plain-text not_found on stdout after malformed stderr", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: "{malformed json",
				stdout: "not_found: pane w1:p1",
			});
			assert.deepEqual(result, { kind: "missing", error: "not_found: pane w1:p1" });
		});

		it("normalizes unknown agent_status values", () => {
			const result = __herdrTest__.parsePaneGetOutput(
				JSON.stringify({
					result: { pane: { pane_id: "w1:p1", agent: "pi", agent_status: "paused" } },
				}),
				"w1:p1",
			);
			assert.deepEqual(result, { kind: "present", agent: "pi", agentStatus: "unknown" });
		});
	});
});
