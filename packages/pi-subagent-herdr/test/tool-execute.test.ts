import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLifecycle } from "../src/lifecycle.ts";
import { createToolExecute } from "../src/tool-execute.ts";

const fakePi = {
	getThinkingLevel() {
		return "low";
	},
} as any;

function withProject(run: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "tool-execute-"));
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "reviewer.md"), "---\nname: reviewer\ntools: read\n---\n\nReview the task.\n");
	return run(cwd).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

function stableContext(cwd: string, sessionId: string) {
	return {
		cwd,
		agentDir: join(cwd, "global"),
		projectTrusted: true,
		sessionFile: join(cwd, "parent.jsonl"),
		sessionId,
		sessionDir: join(cwd, "session-data"),
	};
}

function createExecutor(cwd: string, sessionId: string, overrides: Record<string, unknown> = {}) {
	const context = stableContext(cwd, sessionId);
	return createToolExecute({
		snapshotParentContext: () => context,
		resolveBlocking: () => false,
		createRunId: () => `${sessionId}-run`,
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
		...overrides,
	} as Parameters<typeof createToolExecute>[0]);
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
	process.env.HERDR_PANE_ID = "tool-execute-parent";
	return run().finally(() => {
		if (previous === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previous;
	});
}

describe("subagent tool execution", () => {
	it("reports the setup error before requesting admission when Herdr is unavailable", async () => {
		await withProject(async (cwd) => {
			const execute = createExecutor(cwd, "unavailable", {
				isTerminalAvailable: () => false,
				terminalSetupHint: () => "Start Herdr first.",
			});

			const result = await execute(
				fakePi,
				undefined,
				{ agent: "reviewer", task: "Review this." },
				undefined,
				undefined,
				fakeExtensionContext(),
			);

			assert.equal(result.isError, undefined);
			assert.equal(result.details.error, "herdr not available");
			assert.equal(result.content[0].text, "Subagents require herdr. Start Herdr first.");
		});
	});

	it("starts a background run with the resolved runtime plan and releases its admission", async () => {
		await withProject(async (cwd) => {
			let spawnOptions: any;
			let widgetUpdates = 0;
			const execute = createExecutor(cwd, "background", {
				startBackgroundSpawn: async (options: any) => {
					spawnOptions = options;
					return {
						id: options.runId,
						name: "Visible label",
						agent: "reviewer",
						task: options.params.task,
						surface: "child-pane",
						startTime: Date.now(),
						sessionFile: join(cwd, "child.jsonl"),
						launchScriptFile: join(cwd, "launch.sh"),
						lifecycle: createLifecycle(Date.now()),
						runtimePlan: options.runtimePlan,
					};
				},
				updateWidget: () => {
					widgetUpdates++;
				},
			});

			const result = await withPaneId(() =>
				execute(
					fakePi,
					undefined,
					{ agent: "reviewer", label: "Visible label", task: "Review this." },
					undefined,
					undefined,
					fakeExtensionContext(),
				),
			);

			assert.equal(result.isError, undefined);
			assert.equal(result.details.status, "started");
			assert.equal(result.details.class, "background");
			assert.equal(result.details.model, "test/model");
			assert.equal(result.details.thinking, "low");
			assert.equal(spawnOptions.params.task, "Review this.");
			assert.equal(spawnOptions.selectedSkills.length, 0);
			assert.equal(spawnOptions.admissionLease.state, "admitted");
			assert.ok(widgetUpdates >= 1);
			spawnOptions.admissionLease.release();
		});
	});

	it("settles a blocking run, commits the launch, and releases run ownership", async () => {
		await withProject(async (cwd) => {
			let committed = false;
			let released = false;
			let captured = false;
			const execute = createExecutor(cwd, "blocking", {
				resolveBlocking: () => true,
				launchSubagent: async (_params: any, _ctx: any, options: any) => ({
					id: options.runId,
					name: "Blocking label",
					agent: "reviewer",
					task: "Wait for completion.",
					surface: "child-pane",
					startTime: Date.now(),
					sessionFile: join(cwd, "child.jsonl"),
					lifecycle: createLifecycle(Date.now()),
					runtimePlan: options.runtimePlan,
					admissionLease: options.admissionLease,
				}),
				watchSubagent: async () => ({
					name: "Blocking label",
					task: "Wait for completion.",
					summary: "Completed cleanly.",
					exitCode: 0,
					elapsed: 1,
				}),
				commitRunningLaunch: () => {
					committed = true;
				},
				releaseRunOwnership: (running: any) => {
					released = true;
					running.admissionLease.release();
				},
				captureStickyTerminalRun: () => {
					captured = true;
					return false;
				},
			});

			const result = await withPaneId(() =>
				execute(
					fakePi,
					undefined,
					{ agent: "reviewer", label: "Blocking label", task: "Wait for completion." },
					undefined,
					undefined,
					fakeExtensionContext(),
				),
			);

			assert.equal(result.isError, false);
			assert.equal(result.details.status, "completed");
			assert.equal(result.content[0].text, "Completed cleanly.");
			assert.equal(committed, true);
			assert.equal(released, true);
			assert.equal(captured, true);
		});
	});
});
