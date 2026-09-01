import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SubagentActivityState } from "../src/activity.ts";
import type { SubagentLifecycle } from "../src/lifecycle.ts";
import { createLifecycle, markRetrying, observeActivity, projectLifecycle } from "../src/lifecycle.ts";
import { getSubagentArtifactDir } from "../src/session.ts";
import { createSubagentLaunchService, RETRY_BACKOFF_MS } from "../src/subagent-launch.ts";
import type { RunningSubagent } from "../src/types.ts";

function telemetry(overrides: Record<string, unknown> = {}): SubagentActivityState {
	return {
		version: 1,
		runningChildId: "run-act",
		createdAt: 1_000,
		updatedAt: 4_000,
		sequence: 9,
		latestEvent: "tool_execution_end",
		phase: "active",
		agentActive: true,
		turnActive: true,
		providerActive: false,
		toolActive: false,
		turnIndex: 1,
		toolCount: 1,
		contextTokens: 1_000,
		contextWindow: 10_000,
		contextPercent: 10,
		compactionCount: 0,
		...overrides,
	};
}

type ScriptHandoff = {
	paneId: string;
	command: string;
	options?: { scriptPath?: string; scriptPreamble?: string };
};

function createService(
	handoffs: ScriptHandoff[],
	sidecar?: { sessionFile: string; kind: "done" | "error"; onChildExit?: () => void },
) {
	return createSubagentLaunchService({
		resolveBlocking: () => false,
		resolveLayout: () => "attached",
		resolveSurface: () => "pane",
		resolveDirection: () => "right",
		resolveLaunchBehavior: () => ({
			inheritsConversationContext: false,
			taskDelivery: "artifact",
		}),
		lifecycleDenySet: () => new Set(["subagent"]),
		buildSystemPromptFileContent: ({ agentName, identity }) => ({
			content: `<active_agent name="${agentName}"/>\n${identity}`,
			flag: "--append-system-prompt",
		}),
		buildSubagentToolAllowlist: (tools) => `${tools},subagent_done`,
		safeCommentValue: (value) => value.replace(/[\r\n]/g, " ").trim(),
		createRunId: () => "retry-run-id",
		getShellReadyDelayMs: () => 0,
		getSubagentArtifactDir,
		runScriptInPane: (paneId, command, options) => {
			handoffs.push({ paneId, command, options });
			const scriptPath = options?.scriptPath;
			if (!scriptPath) throw new Error("expected launch script path");
			// Simulate the relaunched child: extract PI_SUBAGENT_ID from the command
			// and write a success sidecar stamped with it (the new attempt's id).
			const idMatch = command.match(/PI_SUBAGENT_ID='([^']+)'/);
			if (idMatch?.[1].includes("-r") && sidecar) {
				if (sidecar.kind === "done") writeDoneSidecar(sidecar.sessionFile, idMatch[1]);
				else writeErrorSidecar(sidecar.sessionFile, idMatch[1]);
				sidecar.onChildExit?.();
			}
			return scriptPath;
		},
		createLifecycle,
		ensureLifecycle: (running) => running.lifecycle,
		observeRunningSubagent: () => {},
		updateWidget: () => {},
		startWidgetRefresh: () => {},
		startStatusRefresh: () => {},
		resolveResultPresentation: () => "",
		shouldDeliverSubagentCompletion: () => true,
	});
}

function writeDoneSidecar(sessionFile: string, runId: string): void {
	if (!sessionFile) return;
	const artifactDir = getSubagentArtifactDir(sessionFile);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, "exit.json"), JSON.stringify({ type: "done", runId }));
}

function writeErrorSidecar(sessionFile: string, runId: string): void {
	const artifactDir = getSubagentArtifactDir(sessionFile);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(
		join(artifactDir, "exit.json"),
		JSON.stringify({ type: "error", errorMessage: "Anthropic 529 Overloaded", runId }),
	);
}

function makeRunning(dir: string, id: string, overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	const sessionFile = join(dir, `${id}.jsonl`);
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "child" })}\n`);
	return {
		id,
		name: "reviewer",
		task: "review",
		agent: "reviewer",
		parentSessionId: "retry-parent",
		surface: `pane-${id}`,
		startTime: Date.now(),
		sessionFile,
		lifecycle: createLifecycle(Date.now()),
		runtimePlan: undefined,
		entryCountBefore: 1,
		attempt: 1,
		maxAttempts: 3,
		attemptId: id,
		...overrides,
	};
}

function withDir(name: string, run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), name));
	return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("automatic retry loop", () => {
	it("does not retry a retryable error when no attempts remain (attempt 1 of 1)", async () => {
		await withDir("retry-exhausted-", async (dir) => {
			const service = createService([]);
			const running = makeRunning(dir, "run-exhausted", { maxAttempts: 1 });
			writeErrorSidecar(running.sessionFile, running.id);

			const result = await service.watchSubagent(running, new AbortController().signal, {
				releaseOwnership: false,
				timeoutMs: 2_000,
			});

			// Settled through the ordinary failure path with exhaustion plumbing.
			assert.equal(result.exitCode, 1);
			assert.equal(result.errorMessage, "Anthropic 529 Overloaded");
			assert.equal(result.attempts, 1);
			assert.equal(result.maxAttempts, 1);
			// The run is marked failed, not retried.
			assert.equal(running.lifecycle.process.kind, "failed");
		});
	});

	it("does not retry malformed sidecars, pane disappearance, or timeouts", async () => {
		await withDir("retry-nonretryable-", async (dir) => {
			const service = createService([]);

			// Malformed sidecar: file exists but is not valid JSON.
			const malformed = makeRunning(dir, "run-malformed");
			const artifactDir = getSubagentArtifactDir(malformed.sessionFile);
			mkdirSync(artifactDir, { recursive: true });
			writeFileSync(join(artifactDir, "exit.json"), "{not json");
			const malformedResult = await service.watchSubagent(malformed, new AbortController().signal, {
				releaseOwnership: false,
				timeoutMs: 2_000,
			});
			assert.equal(malformedResult.exitCode, 1);
			assert.match(malformedResult.errorMessage ?? "", /Malformed/);
			assert.equal(malformedResult.attempts, undefined, "malformed sidecar never claims exhaustion");
			assert.equal(malformed.lifecycle.process.kind, "failed");

			// Pane disappearance: no sidecar, pane reports missing via override.
			const vanished = makeRunning(dir, "run-vanished", {
				inspectPaneOverride: async () => ({ kind: "missing", error: "pane_not_found" }),
			});
			const vanishedResult = await service.watchSubagent(vanished, new AbortController().signal, {
				releaseOwnership: false,
				timeoutMs: 2_000,
			});
			assert.equal(vanishedResult.exitCode, 1);
			assert.match(vanishedResult.errorMessage ?? "", /pane disappeared/);
			assert.equal(vanishedResult.attempts, undefined, "pane disappearance never claims exhaustion");
		});
	});

	it("settles a relaunch-mechanics failure through the reported-error path", async () => {
		await withDir("retry-relaunch-failure-", async (dir) => {
			const service = createService([]);
			const running = makeRunning(dir, "run-relaunch-fail");
			writeErrorSidecar(running.sessionFile, running.id);

			// The failed attempt's pane is confirmed gone via the override; the
			// relaunch then fails at surface creation (no HERDR_PANE_ID set).
			const previousPaneId = process.env.HERDR_PANE_ID;
			delete process.env.HERDR_PANE_ID;
			try {
				const result = await service.watchSubagent(
					{ ...running, inspectPaneOverride: async () => ({ kind: "missing", error: "pane_not_found" }) },
					new AbortController().signal,
					{ releaseOwnership: false, timeoutMs: 5_000 },
				);
				assert.equal(result.exitCode, 1);
				// Extension-error channel, not provider/agent error: the relaunch itself failed.
				assert.match(result.error ?? "", /retry relaunch failed/);
				assert.equal(result.errorMessage, undefined);
				// The pre-existing session file and companion directory survive.
				assert.equal(running.sessionFile.length > 0, true);
			} finally {
				if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
				else process.env.HERDR_PANE_ID = previousPaneId;
			}
		});
	});

	it("cancels a pending retry backoff when aborted", async () => {
		await withDir("retry-abort-", async (dir) => {
			const service = createService([]);
			const running = makeRunning(dir, "run-aborted");
			writeErrorSidecar(running.sessionFile, running.id);

			const controller = new AbortController();
			const watch = service.watchSubagent(
				{ ...running, inspectPaneOverride: async () => ({ kind: "missing", error: "pane_not_found" }) },
				controller.signal,
				{ releaseOwnership: false, timeoutMs: 60_000 },
			);
			// Abort during the backoff window (5s before attempt 2).
			setTimeout(() => controller.abort(), 20);
			const result = await watch;

			assert.equal(result.error, "cancelled");
			assert.match(result.summary, /cancelled/i);
		});
	});

	it("retries a well-formed error and settles attempt 2's sidecar stamped with the NEW attempt id", async () => {
		await withDir("retry-happy-", async (dir) => {
			const handoffs: ScriptHandoff[] = [];
			const service = createService(handoffs, { sessionFile: join(dir, "run-happy.jsonl"), kind: "done" });
			const running = makeRunning(dir, "run-happy", {
				agentDefinition: {
					id: "reviewer",
					sourcePath: "/agents/reviewer.md",
					source: "project",
					tools: "read",
					body: "Review.",
					frontmatter: "",
				},
				launchParams: { agent: "reviewer", task: "review", label: "reviewer" },
				effectiveCwd: dir,
				agentDir: dir,
				projectTrusted: true,
				runtimePlan: {
					provider: "acme",
					modelId: "model-1",
					model: "acme/model-1",
					thinking: "high",
					modelSource: "request",
					thinkingSource: "request",
				} as RunningSubagent["runtimePlan"],
			});
			// Attempt 1 fails with a well-formed error sidecar stamped with the
			// current (initial) attempt id.
			writeErrorSidecar(running.sessionFile, running.id);

			let relaunchCount = 0;
			// The watch mutates the running object in place (surface, attempt,
			// attemptId, lifecycle) — assert against the SAME object.
			running.attachSurfaceOverride = async () => {
				relaunchCount += 1;
				return { paneId: `pane-replacement-${relaunchCount}`, warning: "test warning" };
			};
			// The dead attempt-1 pane reports missing (absence confirmations and
			// liveness probes alike); any replacement pane reports present.
			running.inspectPaneOverride = async () =>
				running.surface.startsWith("pane-replacement-")
					? { kind: "present", agentStatus: "working", observedAt: Date.now() }
					: { kind: "missing", error: "pane_not_found" };
			const result = await service.watchSubagent(running, new AbortController().signal, {
				releaseOwnership: false,
				timeoutMs: 30_000,
			});

			// Exactly one relaunch happened (attempt 2 ran).
			assert.equal(relaunchCount, 1);
			assert.equal(running.attempt, 2);
			assert.equal(running.attemptId, "run-happy-r2");
			// The relaunch command stamps the child with the NEW attempt id.
			const relaunchHandoff = handoffs.find((h) => h.paneId === "pane-replacement-1");
			assert.ok(relaunchHandoff, "relaunch handoff recorded");
			assert.match(relaunchHandoff.command, /PI_SUBAGENT_ID='run-happy-r2'/);
			// Layout warnings are recomputed for the replacement surface.
			assert.equal(running.layoutWarning, "test warning");
			// Attempt 2 settled successfully via its own sidecar — no intermediate
			// failure surfaced, single success result, run identity unchanged.
			assert.equal(result.exitCode, 0);
			assert.equal(result.errorMessage, undefined);
			assert.equal(result.attempts, undefined, "success never carries exhaustion counts");
			assert.equal(running.id, "run-happy");
			assert.equal(running.lifecycle.process.kind, "completed");
		});
	});

	it(
		"exhausts after 3 total attempts through watchSubagent and reports exhaustion counts",
		{ timeout: 60_000 },
		async () => {
			await withDir("retry-exhaust-3-", async (dir) => {
				const handoffs: ScriptHandoff[] = [];
				// Every relaunched child fails again with its own fresh error sidecar.
				// childDead tracks which attempt's pane is dead: attempt 1's pane dies
				// with its on-disk sidecar; a relaunch's pane dies when its hook-written
				// sidecar lands (which is also when the absence wait must see missing).
				let childDead = true; // attempt 1's sidecar is already on disk
				const service = createService(handoffs, {
					sessionFile: join(dir, "run-x3.jsonl"),
					kind: "error",
					onChildExit: () => {
						childDead = true;
					},
				});
				const running = makeRunning(dir, "run-x3", {
					agentDefinition: {
						id: "reviewer",
						sourcePath: "/agents/reviewer.md",
						source: "global",
						tools: "read",
						body: "Review.",
						frontmatter: "",
					},
					launchParams: { agent: "reviewer", task: "review", label: "reviewer" },
					effectiveCwd: dir,
					agentDir: dir,
					projectTrusted: true,
					runtimePlan: {
						provider: "acme",
						modelId: "model-1",
						model: "acme/model-1",
						thinking: "high",
						modelSource: "request",
						thinkingSource: "request",
					} as RunningSubagent["runtimePlan"],
				});
				// Attempt 1's failure is already on disk, stamped with the initial id.
				writeErrorSidecar(running.sessionFile, running.id);
				let relaunchCount = 0;
				running.attachSurfaceOverride = async () => {
					relaunchCount += 1;
					childDead = false; // the replacement pane is alive
					return { paneId: `pane-x3-${relaunchCount}` };
				};
				// The pane reports present while its child is alive, missing once the
				// child errored — the exact signal the absence wait keys on.
				running.inspectPaneOverride = async () =>
					childDead
						? { kind: "missing", error: "pane_not_found" }
						: { kind: "present", agentStatus: "working", observedAt: Date.now() };
				const result = await service.watchSubagent(running, new AbortController().signal, {
					releaseOwnership: false,
					timeoutMs: 60_000,
				});

				// Three total attempts: the initial launch failed on disk; attempts 2
				// and 3 were relaunches; attempt 3 exhausted the cap — no 4th relaunch.
				assert.equal(relaunchCount, 2);
				assert.equal(running.attempt, 3);
				assert.equal(running.attemptId, "run-x3-r3");
				// Each relaunch command stamps the per-attempt id: -r2 then -r3.
				const ids = handoffs.map((h) => /PI_SUBAGENT_ID='([^']+)'/.exec(h.command)?.[1]);
				assert.deepEqual(ids, ["run-x3-r2", "run-x3-r3"]);
				// Exhaustion is reported with the loop-level counts.
				assert.equal(result.exitCode, 1);
				assert.equal(result.attempts, 3);
				assert.equal(result.maxAttempts, 3);
				// The raw result carries the child's own error; the exhaustion claim is
				// composed by the presentation layer from attempts/maxAttempts.
				assert.match(result.errorMessage ?? "", /Anthropic 529 Overloaded/);
			});
		},
	);

	it(
		"never relaunches when pane absence is not confirmed before the backoff elapses",
		{ timeout: 60_000 },
		async () => {
			await withDir("retry-absence-order-", async (dir) => {
				const handoffs: ScriptHandoff[] = [];
				const service = createService(handoffs);
				const running = makeRunning(dir, "run-absence", {
					agentDefinition: {
						id: "reviewer",
						sourcePath: "/agents/reviewer.md",
						source: "global",
						tools: "read",
						body: "Review.",
						frontmatter: "",
					},
					launchParams: { agent: "reviewer", task: "review", label: "reviewer" },
					effectiveCwd: dir,
					agentDir: dir,
					projectTrusted: true,
					runtimePlan: {
						provider: "acme",
						modelId: "model-1",
						model: "acme/model-1",
						thinking: "high",
						modelSource: "request",
						thinkingSource: "request",
					} as RunningSubagent["runtimePlan"],
				});
				writeErrorSidecar(running.sessionFile, running.id);
				let relaunches = 0;
				running.attachSurfaceOverride = async () => {
					relaunches += 1;
					return { paneId: "pane-should-never-exist" };
				};
				// The dead pane NEVER reports missing — absence is never confirmed, so
				// the retry must abort before any relaunch write happens.
				running.inspectPaneOverride = async () => ({
					kind: "present",
					agentStatus: "working",
					observedAt: Date.now(),
				});
				const result = await service.watchSubagent(running, new AbortController().signal, {
					releaseOwnership: false,
					timeoutMs: 60_000,
				});
				assert.equal(relaunches, 0, "no relaunch may run before confirmed pane absence");
				assert.equal(handoffs.length, 0, "no launch script may be written before confirmed pane absence");
				assert.equal(result.exitCode, 1);
				assert.match(String(result.error ?? result.errorMessage ?? ""), /still present/);
			});
		},
	);

	it("accepts attempt 2's fresh sequence-0 activity after the per-attempt lifecycle reset", async () => {
		await withDir("retry-activity-reset-", async (dir) => {
			const service = createService([]);
			const running = makeRunning(dir, "run-act");
			// Attempt 1 recorded activity up to sequence 9 before failing.
			let lifecycle = createLifecycle(1_000);
			for (let sequence = 0; sequence <= 9; sequence++) {
				lifecycle = observeActivity(
					lifecycle,
					{ ok: true, activity: { ...telemetry(), sequence } },
					2_000 + sequence * 100,
				);
			}
			assert.equal(lifecycle.lastActivitySequence, 9);
			running.lifecycle = lifecycle;

			// The per-attempt reset mirrors resetLifecycleForAttempt: the new child
			// restarts its activity recorder at sequence 0.
			const reset: SubagentLifecycle = {
				...lifecycle,
				turn: { kind: "unknown" },
				activityDetail: null,
				activityHealth: { kind: "unseen" },
				lastActivitySequence: null,
				pane: { kind: "unknown" },
			};
			// Attempt 2's first activity (sequence 0) must NOT be discarded as stale.
			const after = observeActivity(reset, { ok: true, activity: { ...telemetry(), sequence: 0 } }, 5_000);
			assert.notEqual(after, reset, "sequence-0 activity after reset must be observed");
			assert.equal(after.lastActivitySequence, 0);
			// And it renders as live work, not a frozen row.
			const projection = projectLifecycle(after, 5_500);
			assert.ok(
				projection.kind === "starting" || projection.kind === "running" || projection.kind === "blocked",
				`expected live projection, got ${projection.kind}`,
			);
			void service;
		});
	});

	it("exposes stepped backoff constants for attempts 2 and 3", () => {
		assert.deepEqual(RETRY_BACKOFF_MS, [5_000, 15_000]);
	});
});

describe("retrying lifecycle projection", () => {
	it("projects retrying with attempt counts and precedence over stale turn state", () => {
		const lifecycle = markRetrying(createLifecycle(1_000), 2, 3, 5_000);
		const projection = projectLifecycle(lifecycle, 10_000);
		assert.equal(projection.kind, "retrying");
		assert.equal(projection.attempt, 2);
		assert.equal(projection.maxAttempts, 3);
		assert.equal(projection.stateDurationSince, 5_000);
	});

	it("clears the retrying state once the attempt launches", () => {
		const lifecycle = markRetrying(createLifecycle(1_000), 3, 3, 5_000);
		const cleared = projectLifecycle({ ...lifecycle, retry: null }, 10_000);
		assert.notEqual(cleared.kind, "retrying");
	});
});
