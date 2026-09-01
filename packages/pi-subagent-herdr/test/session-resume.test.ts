import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLifecycle } from "../src/lifecycle.ts";
import { getSessionLeaseRegistry } from "../src/session-leases.ts";
import { createToolExecute } from "../src/tool-execute.ts";

const fakePi = {
	getThinkingLevel() {
		return "low";
	},
} as any;

function safeCwdSegment(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

interface ResumeEnv {
	cwd: string;
	agentDir: string;
	sessionId: string;
	sessionsDir: string;
	/** Create an owned session file under the child-sessions directory. */
	createOwnedSession(overrides?: { parentSessionId?: string; agentId?: string }): string;
}

function withResumeEnv(run: (env: ResumeEnv) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "resume-"));
	const agentDir = join(cwd, "agent-dir");
	const sessionId = "parent-session-1";
	const sessionsDir = join(agentDir, "sessions", safeCwdSegment(cwd));
	mkdirSync(sessionsDir, { recursive: true });
	const env: ResumeEnv = {
		cwd,
		agentDir,
		sessionId,
		sessionsDir,
		createOwnedSession(overrides = {}) {
			const file = join(sessionsDir, `2026-01-01T00-00-00-000Z-${overrides.agentId ?? "reviewer"}-abc.jsonl`);
			const header = {
				type: "session",
				version: 3,
				id: "child-1",
				timestamp: new Date().toISOString(),
				cwd,
				parentSession: join(cwd, "parent.jsonl"),
				subagentOwner: {
					version: 2,
					token: "0".repeat(64),
					agentId: overrides.agentId ?? "reviewer",
					parentSessionId: overrides.parentSessionId ?? sessionId,
				},
			};
			writeFileSync(file, `${JSON.stringify(header)}\n`);
			return file;
		},
	};
	writeFileSync(join(cwd, "parent.jsonl"), `${JSON.stringify({ type: "session", id: sessionId })}\n`);
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "agents", "reviewer.md"),
		"---\nname: reviewer\ntools: read\n---\n\nReview the task.\n",
	);
	writeFileSync(join(agentDir, "agents", "coder.md"), "---\nname: coder\ntools: read\n---\n\nCode the task.\n");
	return run(env).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

function createResumeExecutor(env: ResumeEnv, params: any) {
	const context = {
		cwd: env.cwd,
		agentDir: env.agentDir,
		projectTrusted: true,
		sessionFile: join(env.cwd, "parent.jsonl"),
		sessionId: env.sessionId,
	};
	const execute = createToolExecute({
		snapshotParentContext: () => context,
		resolveBlocking: () => false,
		createRunId: () => "resume-run-1",
		clearStickyTerminalsOnAdmission: () => {},
		startBackgroundSpawn: async () => {
			throw new Error("startBackgroundSpawn was not configured");
		},
		captureStickyLaunchFailure: () => {},
		launchSubagent: async () => {
			throw new Error("launchSubagent was not configured");
		},
		watchSubagent: async () => ({ name: "reviewer", task: "", summary: "", exitCode: 0, elapsed: 0 }),
		commitRunningLaunch: () => {},
		failLaunch: () => {},
		releaseRunOwnership: () => {},
		captureStickyTerminalRun: () => false,
		updateWidget: () => {},
		startWidgetRefresh: () => {},
		startStatusRefresh: () => {},
		appendLayoutWarning: (text: string) => text,
		resolveResultPresentation: (result: { summary: string }) => result.summary,
		shouldDeliverSubagentCompletion: () => true,
		isTerminalAvailable: () => true,
	} as Parameters<typeof createToolExecute>[0]);

	return () =>
		withPaneId(() =>
			execute(
				fakePi,
				undefined,
				{ agent: "reviewer", task: "Continue.", ...params },
				undefined,
				undefined,
				fakeExtensionContext(),
			),
		);
}

function fakeExtensionContext() {
	return {
		model: { provider: "test", id: "model" },
		modelRegistry: {
			find() {
				return undefined;
			},
		},
	} as any;
}

function withPaneId<T>(run: () => Promise<T>): Promise<T> {
	const previous = process.env.HERDR_PANE_ID;
	process.env.HERDR_PANE_ID = "resume-parent";
	return run().finally(() => {
		if (previous === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previous;
	});
}

describe("session resume validation", () => {
	it("rejects a nonexistent session path before any resource creation", async () => {
		await withResumeEnv(async (env) => {
			const run = createResumeExecutor(env, { session: join(env.cwd, "missing.jsonl") });
			const result = await run();
			assert.equal(result.isError, true);
			assert.match(String(result.details.error), /no existing subagent session file/);
		});
	});

	it("rejects a non-.jsonl path inside the sessions directory", async () => {
		await withResumeEnv(async (env) => {
			const rogue = join(env.sessionsDir, "not-a-session.txt");
			writeFileSync(rogue, "hello\n");
			const run = createResumeExecutor(env, { session: rogue });
			const result = await run();
			assert.equal(result.isError, true);
			assert.match(String(result.details.error), /not a subagent session file \(\.jsonl\)/);
		});
	});

	it("rejects a session outside the parent's child-sessions directory", async () => {
		await withResumeEnv(async (env) => {
			const foreign = join(env.cwd, "elsewhere.jsonl");
			writeFileSync(foreign, `${JSON.stringify({ type: "session" })}\n`);
			const run = createResumeExecutor(env, { session: foreign });
			const result = await run();
			assert.equal(result.isError, true);
			assert.match(String(result.details.error), /outside this parent's child-sessions directory/);
		});
	});

	it("rejects a symlink that escapes the sessions directory", async () => {
		await withResumeEnv(async (env) => {
			const target = join(env.cwd, "escape-target.jsonl");
			writeFileSync(target, `${JSON.stringify({ type: "session" })}\n`);
			const link = join(env.sessionsDir, "link.jsonl");
			symlinkSync(target, link);
			const run = createResumeExecutor(env, { session: link });
			const result = await run();
			assert.equal(result.isError, true);
			assert.match(String(result.details.error), /outside this parent's child-sessions directory/);
		});
	});

	it("rejects a session owned by a foreign parent session", async () => {
		await withResumeEnv(async (env) => {
			const file = env.createOwnedSession({ parentSessionId: "other-parent" });
			const run = createResumeExecutor(env, { session: file });
			const result = await run();
			assert.equal(result.isError, true);
			assert.match(String(result.details.error), /different parent session/);
		});
	});

	it("rejects a session owned by a different agent", async () => {
		await withResumeEnv(async (env) => {
			const file = env.createOwnedSession({ agentId: "coder" });
			const run = createResumeExecutor(env, { session: file });
			const result = await run();
			assert.equal(result.isError, true);
			assert.match(String(result.details.error), /belongs to agent/);
		});
	});

	it("rejects a session held by a live lease", async () => {
		await withResumeEnv(async (env) => {
			const file = env.createOwnedSession();
			const lease = getSessionLeaseRegistry(env.sessionId).acquire(file, "other-run", "running");
			try {
				const run = createResumeExecutor(env, { session: file });
				const result = await run();
				assert.equal(result.isError, true);
				assert.match(String(result.details.error), /held by a live run/);
			} finally {
				lease.release();
			}
		});
	});

	it("passes the canonical session file through to the launch", async () => {
		await withResumeEnv(async (env) => {
			const file = env.createOwnedSession();
			let spawnOptions: any;
			const context = {
				cwd: env.cwd,
				agentDir: env.agentDir,
				projectTrusted: true,
				sessionFile: join(env.cwd, "parent.jsonl"),
				sessionId: env.sessionId,
			};
			const execute = createToolExecute({
				snapshotParentContext: () => context,
				resolveBlocking: () => false,
				createRunId: () => "resume-run-2",
				clearStickyTerminalsOnAdmission: () => {},
				startBackgroundSpawn: async (options: any) => {
					spawnOptions = options;
					return {
						id: options.runId,
						name: "reviewer",
						agent: "reviewer",
						task: options.params.task,
						surface: "child-pane",
						startTime: Date.now(),
						sessionFile: options.resumeSessionFile,
						lifecycle: createLifecycle(Date.now()),
						runtimePlan: options.runtimePlan,
					};
				},
				captureStickyLaunchFailure: () => {},
				launchSubagent: async () => {
					throw new Error("launchSubagent was not configured");
				},
				watchSubagent: async () => ({ name: "reviewer", task: "", summary: "", exitCode: 0, elapsed: 0 }),
				commitRunningLaunch: () => {},
				failLaunch: () => {},
				releaseRunOwnership: () => {},
				captureStickyTerminalRun: () => false,
				updateWidget: () => {},
				startWidgetRefresh: () => {},
				startStatusRefresh: () => {},
				appendLayoutWarning: (text: string) => text,
				resolveResultPresentation: (result: { summary: string }) => result.summary,
				shouldDeliverSubagentCompletion: () => true,
				isTerminalAvailable: () => true,
			} as Parameters<typeof createToolExecute>[0]);

			const result = await withPaneId(() =>
				execute(
					fakePi,
					undefined,
					{ agent: "reviewer", task: "Continue.", session: file },
					undefined,
					undefined,
					fakeExtensionContext(),
				),
			);
			assert.equal(result.isError, undefined);
			// The launch receives the CANONICAL path (realpath-resolved).
			assert.equal(spawnOptions.resumeSessionFile, realpathSync(file));
		});
	});
});
