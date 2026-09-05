import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../src/agent-definition.ts";
import { isPermanentErrorCompletion, isRetryableCompletion, PERMANENT_ERROR_RE } from "../src/completion.ts";
import * as subagentsModule from "../src/index.ts";
import { createLifecycle } from "../src/lifecycle.ts";
import { getSubagentArtifactDir } from "../src/session.ts";
import { getSessionLeaseRegistry } from "../src/session-leases.ts";
import { createSubagentLaunchService } from "../src/subagent-launch.ts";
import type { RunningSubagent, SubagentResult } from "../src/types.ts";
import { renderSubagentResultMessage } from "../src/widget.ts";
import { createPlainWidgetTheme } from "./widget-theme.ts";

const testApi = (subagentsModule as any).__test__;
const theme = createPlainWidgetTheme();
initTheme("dark");

type PresentationResult = Pick<
	SubagentResult,
	| "exitCode"
	| "elapsed"
	| "summary"
	| "sessionFile"
	| "errorMessage"
	| "watchAbandoned"
	| "attempts"
	| "maxAttempts"
	| "agent"
	| "permanentError"
>;

const resolveResultPresentation: (
	result: PresentationResult,
	name: string,
	runId?: string,
	agentId?: string,
) => string = testApi.resolveResultPresentation;

const RESUME_TASK = "continue the task from where it failed";
/** The parent-session id used for lease-registry isolation in this file. */
const PARENT = "resume-delivery-parent";

function exhaustedResult(overrides: Partial<PresentationResult> = {}): PresentationResult {
	return {
		exitCode: 1,
		elapsed: 94,
		summary: "ignored when errorMessage is present",
		sessionFile: "/tmp/child/failed.jsonl",
		errorMessage: "Anthropic 529 Overloaded after 3 retries",
		attempts: 3,
		maxAttempts: 3,
		agent: "reviewer",
		...overrides,
	};
}

// ── 4.1: presentation text ──

describe("resume-first failure presentation", () => {
	it("exhaustion text carries the exact resume invocation, the permanent rule, and no respawn instruction", () => {
		const text = resolveResultPresentation(exhaustedResult(), "Review Pass", "run-1", "reviewer");
		assert.match(text, /provider\/agent error — auto-retry exhausted after 3 attempts\)\./);
		assert.match(text, /Error: Anthropic 529 Overloaded after 3 retries/);
		assert.match(
			text,
			/subagent\(\{ agent: "reviewer", task: "continue the task from where it failed", session: "\/tmp\/child\/failed\.jsonl" }\)/,
		);
		assert.match(text, /If the error is permanent \(quota exhausted, billing, invalid credentials\), do not/);
		assert.match(text, /resume and do not spawn a replacement — surface this error to the user\./);
		assert.doesNotMatch(text, /spawning a new subagent|spawn a new subagent/i);
		assert.doesNotMatch(text, /inspect or continue it directly from its pane/);
		// The session log line stays last for the widget's summary strip.
		assert.ok(text.endsWith("\n\nSession log: /tmp/child/failed.jsonl"));
	});

	it("names the canonical agent id — never the presentation label — even when the label differs", () => {
		const text = resolveResultPresentation(exhaustedResult(), "Review Pass", "run-1", "reviewer");
		assert.match(text, /agent: "reviewer"/);
		assert.doesNotMatch(text, /agent: "Review Pass"/);
		// The label is still the human-facing name in the header.
		assert.match(text, /Sub-agent "Review Pass" \[run-1\] failed/);
	});

	it("falls back to the result-stamped agent id when no run-threaded id is supplied", () => {
		const text = resolveResultPresentation(exhaustedResult(), "reviewer", "run-1");
		assert.match(text, /agent: "reviewer"/);
	});

	it("short-circuit variant states no further automatic retry was attempted, attempt-accurately", () => {
		// Pattern first matched on attempt 1: no earlier attempts ran, so the
		// wording must not mention any.
		const firstAttempt = resolveResultPresentation(
			exhaustedResult({ attempts: undefined, maxAttempts: undefined, permanentError: true }),
			"reviewer",
			"run-1",
			"reviewer",
		);
		assert.match(firstAttempt, /no further automatic retry attempted because the error looked permanent/);
		assert.doesNotMatch(firstAttempt, /earlier attempt/);
		assert.doesNotMatch(firstAttempt, /auto-retry exhausted/);
		assert.match(firstAttempt, /agent: "reviewer"/);

		// Pattern first matched on attempt 2 (one retry already ran): the wording
		// reflects the earlier attempt without claiming exhaustion.
		const laterAttempt = resolveResultPresentation(
			exhaustedResult({
				attempts: 2,
				maxAttempts: undefined,
				permanentError: true,
				errorMessage: "quota exhausted",
			}),
			"reviewer",
			"run-2",
			"reviewer",
		);
		assert.match(laterAttempt, /no further automatic retry attempted after 1 earlier attempt/);
		assert.doesNotMatch(laterAttempt, /auto-retry exhausted/);
	});

	it("non-exhausted outcomes carry resume + rule with no exhaustion claim and no pane-inspection wording", () => {
		// Malformed sidecar / pane disappearance: no retries ran and the pane is
		// gone (reaped or absent), so the presentation must not claim exhaustion
		// nor direct the parent to inspect a pane that no longer exists.
		const text = resolveResultPresentation(
			exhaustedResult({
				attempts: undefined,
				maxAttempts: undefined,
				errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
			}),
			"reviewer",
			"run-3",
			"reviewer",
		);
		assert.match(text, /provider\/agent error\)\./);
		assert.doesNotMatch(text, /auto-retry exhausted/);
		assert.doesNotMatch(text, /no further automatic retry/);
		assert.match(text, /agent: "reviewer"/);
		assert.match(text, /do not resume and do not spawn a replacement/);
		assert.doesNotMatch(text, /its pane/);
	});

	it("omits the resume invocation rather than emitting a label or empty session as agent", () => {
		// No silent wrong-failure-mode fallbacks: without a canonical agent id
		// or a session path the presentation drops the exact invocation (the
		// session log line still points at the file) — it must never emit the
		// presentation label into `agent:` or an empty `session: ""`.
		const noAgent = resolveResultPresentation(
			exhaustedResult({ agent: undefined }),
			"Review Pass",
			"run-a",
			undefined,
		);
		assert.doesNotMatch(noAgent, /subagent\(\{/);
		assert.doesNotMatch(noAgent, /agent: "Review Pass"/);
		assert.doesNotMatch(noAgent, /session: ""/);
		assert.match(noAgent, /Session log: \/tmp\/child\/failed\.jsonl/);

		const noSession = resolveResultPresentation(
			exhaustedResult({ sessionFile: undefined }),
			"reviewer",
			"run-b",
			"reviewer",
		);
		assert.doesNotMatch(noSession, /subagent\(\{/);
		assert.doesNotMatch(noSession, /session: ""/);
	});

	it("leaves completions, cancellations, and abandoned watches untouched", () => {
		const completed = resolveResultPresentation(
			{ exitCode: 0, elapsed: 12, summary: "All good.", sessionFile: "/tmp/c.jsonl" },
			"reviewer",
			"run-4",
			"reviewer",
		);
		assert.doesNotMatch(completed, /Resume the failed session/);

		const cancelled = resolveResultPresentation(
			{ exitCode: 1, elapsed: 3, summary: "Subagent cancelled.", sessionFile: "/tmp/x.jsonl" },
			"reviewer",
			"run-5",
		);
		assert.match(cancelled, /failed \(exit code 1\)/);
		assert.doesNotMatch(cancelled, /Resume the failed session/);

		const abandoned = resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 14_400,
				summary: "Reviewed three files.",
				sessionFile: "/tmp/a.jsonl",
				errorMessage: "watch stopped",
				watchAbandoned: true,
			},
			"reviewer",
			"run-6",
		);
		assert.match(abandoned, /watch abandoned/);
		// Abandoned panes are preserved — this wording remains accurate there.
		assert.match(abandoned, /pane was\s+left open/i);
		assert.doesNotMatch(abandoned, /Resume the failed session/);
	});
});

// ── 4.1 (widget strip): the resume lines survive the summary heuristics ──

describe("widget summary strip keeps the resume lines intact", () => {
	function renderedFailure(overrides: Partial<PresentationResult> = {}, expanded = true): string {
		const result = exhaustedResult(overrides);
		// Compose exactly what backgroundResultContent/blockingResultText build:
		// the shared presentation over the result, with the run's label + id + agent.
		const content = resolveResultPresentation(result, "Reviewer", "run-2", "reviewer");
		const details = {
			name: "Reviewer",
			id: "run-2",
			elapsed: result.elapsed,
			exitCode: result.exitCode,
			errorMessage: result.errorMessage,
			sessionFile: result.sessionFile,
			attempts: result.attempts,
			maxAttempts: result.maxAttempts,
			agent: result.agent,
		};
		return renderSubagentResultMessage({ content, details }, { expanded }, theme, 140).join("\n");
	}

	it("keeps the resume invocation and permanent-error rule in the expanded summary, session log last", () => {
		const output = renderedFailure();
		assert.match(output, /failed \(provider\/agent error\)/);
		assert.match(output, /Resume the failed session instead of/);
		assert.match(output, /subagent\(\{ agent: "reviewer", task: "continue the task from where it failed"/);
		assert.match(output, /do not resume and do not spawn a replacement/);
		// The widget strips the duplicated provider-failure first line...
		assert.doesNotMatch(output, /Sub-agent "Reviewer" \[run-2\] failed after/);
		// ...and the Session log: line is rendered once, at the end, from details.
		const logLines = output.split("\n").filter((line) => line.includes("Session log:"));
		assert.equal(logLines.length, 1, "the session log appears exactly once");
		assert.ok(
			output.trimEnd().endsWith("Session log: /tmp/child/failed.jsonl"),
			"the session log line is the final rendered line",
		);
	});

	it("strips the short-circuit and non-exhausted first lines without eating the resume lines", () => {
		const shortCircuit = renderedFailure({
			attempts: 2,
			maxAttempts: undefined,
			permanentError: true,
			errorMessage: "quota exhausted",
		});
		assert.match(shortCircuit, /quota exhausted/);
		assert.match(shortCircuit, /subagent\(\{ agent: "reviewer"/);
		assert.doesNotMatch(shortCircuit, /Sub-agent "Reviewer" \[run-2\] failed after/);

		const shortCircuitFirstAttempt = renderedFailure({
			attempts: 1,
			maxAttempts: undefined,
			permanentError: true,
			errorMessage: "quota exhausted",
		});
		assert.doesNotMatch(shortCircuitFirstAttempt, /Sub-agent "Reviewer" \[run-2\] failed after/);
		assert.match(shortCircuitFirstAttempt, /subagent\(\{ agent: "reviewer"/);

		const nonExhausted = renderedFailure({
			attempts: undefined,
			maxAttempts: undefined,
			errorMessage: "Subagent pane disappeared.",
		});
		assert.match(nonExhausted, /Subagent pane disappeared\./);
		assert.match(nonExhausted, /subagent\(\{ agent: "reviewer"/);
		assert.doesNotMatch(nonExhausted, /Sub-agent "Reviewer" \[run-2\] failed after/);
	});
});

// ── 4.4 (classifier): pattern gating and boundary phrasings ──

describe("permanent-error classifier", () => {
	const wellFormed = (errorMessage: string) =>
		({ reason: "error", exitCode: 1, errorMessage, fromErrorSidecar: true }) as const;

	it("matches the pinned quota/billing/auth sidecar phrasings", () => {
		// Pinned against real sidecar phrasings observed in fixtures and providers.
		for (const message of [
			"quota exhausted",
			"Quota has been exhausted for this account",
			"You have exceeded your quota limit",
			"monthly quota exceeded",
			"billing: current payment method has failed",
			"Billing hard limit reached",
			"invalid api key provided",
			"Invalid API Key: sk-abc123",
			"unauthorized: 401 credentials rejected",
			"authentication failed for provider",
			"authentication error",
			"authentication required",
			"failed authentication",
		]) {
			assert.ok(PERMANENT_ERROR_RE.test(message), `expected pattern to match: ${message}`);
			assert.equal(isRetryableCompletion(wellFormed(message)), false, `must not be retried: ${message}`);
			assert.equal(isPermanentErrorCompletion(wellFormed(message)), true);
		}
	});

	it("rejects transient phrasings that textually resemble permanent quota/auth failures", () => {
		// The vetoes stack: the pattern itself must not match the non-quota-verb
		// and auth-verb phrasings; where the pattern still textually matches
		// ("per-minute quota limit reached"), the transient-hint veto must
		// de-classify it. Both directions are miss-safe — the full retry policy
		// is preserved in every case.
		for (const message of [
			"quota limit resets at midnight UTC", // bare `limit` excluded from the quota verbs
			"Rate limit exceeded: per-minute quota limit reached, retry in 60s", // rolling-window 429 — vetoed by transient hints
			"quota resets in 37 seconds",
			"authentication temporarily unavailable, retry", // auth needs a failure verb
			"authentication backend timeout, retry",
		]) {
			assert.equal(
				isPermanentErrorCompletion(wellFormed(message)),
				false,
				`not classified permanent: ${message}`,
			);
			assert.equal(isRetryableCompletion(wellFormed(message)), true, `keeps retry policy: ${message}`);
		}
	});

	it("does not match a plain rate limit without quota — transient 429s keep the full policy", () => {
		for (const message of [
			"Rate limited", // the exact fixture phrasing
			"rate limit exceeded, retry in 37s", // transient backoff wording
			"Anthropic 529 Overloaded", // overload — retryable by design
			"Anthropic 529 Overloaded after 3 retries",
			"529 overloaded",
			"Request was aborted by upstream",
			"stream interrupted",
			"This operation was aborted",
			"boom",
			"quota resets in 37 seconds", // quota noun, no exhaust/exceed/limit verb
			"Your usage is near the limit", // limit without quota or billing
		]) {
			assert.equal(PERMANENT_ERROR_RE.test(message), false, `boundary phrasing must NOT match: ${message}`);
			assert.equal(isRetryableCompletion(wellFormed(message)), true, `keeps retry policy: ${message}`);
			assert.equal(isPermanentErrorCompletion(wellFormed(message)), false);
		}
	});

	it("only classifies well-formed error sidecars — other shapes stay non-retryable and unclassified", () => {
		// Not a sidecar error (malformed sidecar / pane disappearance): not
		// retryable for different reasons, and never "permanent".
		assert.equal(
			isPermanentErrorCompletion({ reason: "error", exitCode: 1, errorMessage: "quota exhausted" }),
			false,
		);
		assert.equal(
			isPermanentErrorCompletion({
				reason: "error",
				exitCode: 1,
				errorMessage: "quota exhausted",
				fromErrorSidecar: true,
			}),
			true,
		);
		assert.equal(isPermanentErrorCompletion({ reason: "timeout", exitCode: 1 }), false);
		assert.equal(
			isPermanentErrorCompletion({ reason: "sentinel", exitCode: 1, errorMessage: "quota exhausted" }),
			false,
		);
		assert.equal(isRetryableCompletion({ reason: "error", exitCode: 1, errorMessage: "quota exhausted" }), false);
	});
});

// ── 4.2 + 4.3 + 4.4 (loop-level): disposition, blocking path, retry policy ──

type ScriptHandoff = {
	paneId: string;
	command: string;
	options?: { scriptPath?: string; scriptPreamble?: string };
};

function createLaunchService(config: { handoffs: ScriptHandoff[]; onRelaunchScript?: (attemptId: string) => void }) {
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
		createRunId: () => "resume-delivery-run",
		getShellReadyDelayMs: () => 0,
		getSubagentArtifactDir,
		runScriptInPane: (paneId, command, options) => {
			config.handoffs.push({ paneId, command, options });
			const scriptPath = options?.scriptPath;
			if (!scriptPath) throw new Error("expected launch script path");
			const idMatch = command.match(/PI_SUBAGENT_ID='([^']+)'/);
			if (idMatch?.[1].includes("-r") && config.onRelaunchScript) config.onRelaunchScript(idMatch[1]);
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

const reviewerDefinition: AgentDefinition = {
	id: "reviewer",
	sourcePath: "/agents/reviewer.md",
	source: "project",
	tools: "read",
	body: "Review.",
	frontmatter: "",
};

function makeRunning(dir: string, id: string, overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	const sessionFile = join(dir, `${id}.jsonl`);
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "child" })}\n`);
	return {
		id,
		name: "Review Pass", // label differs from the canonical agent id
		task: "review",
		agent: "reviewer",
		parentSessionId: PARENT,
		surface: `pane-${id}`,
		startTime: Date.now(),
		sessionFile,
		lifecycle: createLifecycle(Date.now()),
		// A relaunch rebuilds the command from the runtime plan verbatim —
		// a fully resolved plan is required for the retry loop to run.
		runtimePlan: {
			provider: "acme",
			modelId: "model-1",
			model: "acme/model-1",
			thinking: "high",
			modelSource: "request",
			thinkingSource: "request",
		} as RunningSubagent["runtimePlan"],
		entryCountBefore: 1,
		attempt: 1,
		maxAttempts: 3,
		attemptId: id,
		...overrides,
	};
}

function writeSidecar(sessionFile: string, runId: string, errorMessage: string): void {
	const artifactDir = getSubagentArtifactDir(sessionFile);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, "exit.json"), JSON.stringify({ type: "error", errorMessage, runId }));
}

async function withDir(name: string, run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), name));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Present a settled watch result exactly as the delivery sites do. */
function presentedResult(result: SubagentResult, running: RunningSubagent): string {
	return resolveResultPresentation(result, running.name, running.id, running.agent);
}

describe("failed settlement reaps the pane and releases the session lease", () => {
	it("closes the pane path and makes the session immediately resumable at settlement", async () => {
		await withDir("reap-error-pane-", async (dir) => {
			const handoffs: ScriptHandoff[] = [];
			const service = createLaunchService({ handoffs });
			const sessionFile = join(dir, "reap-run.jsonl");
			writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "child" })}\n`);
			const artifactDir = getSubagentArtifactDir(sessionFile);
			mkdirSync(artifactDir, { recursive: true });
			writeFileSync(join(artifactDir, "launch.sh"), "x\n");
			const registry = getSessionLeaseRegistry(PARENT);
			const sessionLease = registry.acquire(sessionFile, "reap-run", "running");
			const running = makeRunning(dir, "reap-run", {
				sessionFile,
				surface: "pane-reap-run",
				inspectPaneOverride: async () => ({ kind: "missing", error: "pane_not_found" }),
				sessionLease,
			});
			writeSidecar(sessionFile, "reap-run", "quota exhausted");

			// releaseOwnership: true — the background watcher shape: ownership
			// (session lease) releases at settlement when the pane is not preserved.
			const result = await service.watchSubagent(running, new AbortController().signal, {
				timeoutMs: 5_000,
			});

			assert.equal(result.errorMessage, "quota exhausted");
			assert.equal(result.permanentError, true, "short-circuit is stamped on the result");
			assert.equal(result.agent, "reviewer", "canonical agent id is stamped on the result");
			// Reaped, not preserved: no error-pane monitor, no admission-only release.
			assert.equal(running.errorPanePreserved, false, "the pane was reaped, not preserved");
			assert.equal(running.errorPaneMonitorStarted, undefined, "no pane monitor was started");
			// The session lease is fully released at settlement — acquire (what
			// resume validation does next) must not see a held lease.
			assert.equal(registry.get(sessionFile), undefined, "session lease released at settlement");
			assert.doesNotThrow(() => registry.acquire(sessionFile, "resumed-run", "starting").release());
			// The companion directory is preserved for diagnosis; transcript kept.
			assert.equal(existsSync(artifactDir), true, "a settled error preserves <stem>/");
			assert.equal(existsSync(sessionFile), true, "the transcript is never deleted");
			assert.equal(running.lifecycle.process.kind, "failed");
		});
	});

	it("escalates to preserve semantics when the post-reap pane probe reports the pane still present", async () => {
		// A transient herdr control-plane failure can leave a reaped pane alive —
		// safeCloseSubagentPane swallows close failures so settlement never
		// stalls. For error sidecars (the outcome whose delivery advertises the
		// session as resumable) the disposition probes the pane once after the
		// reap: an explicit `present` reading escalates to the preserve semantics
		// — monitor started, admission released, session lease retained until
		// confirmed pane disappearance — instead of releasing ownership against a
		// possibly-live writer. (The fake pane id reports missing to herdr's real
		// probes — the override simulates the close having been ineffective.)
		await withDir("reap-failclosed-", async (dir) => {
			const handoffs: ScriptHandoff[] = [];
			const service = createLaunchService({ handoffs });
			const sessionFile = join(dir, "reap-failclosed.jsonl");
			writeFileSync(sessionFile, "");
			const registry = getSessionLeaseRegistry(PARENT);
			const sessionLease = registry.acquire(sessionFile, "reap-failclosed", "running");
			const running = makeRunning(dir, "reap-failclosed", {
				sessionFile,
				inspectPaneOverride: async () => ({ kind: "missing", error: "pane_not_found" }),
				// The close was attempted but INEFFECTIVE: the post-reap verification
				// probe still sees the pane.
				verifyPaneClosedOverride: () => ({ kind: "present", agentStatus: "idle" }),
				sessionLease,
			});
			writeSidecar(sessionFile, "reap-failclosed", "quota exhausted");

			const result = await service.watchSubagent(running, new AbortController().signal, {
				releaseOwnership: false,
				timeoutMs: 5_000,
			});

			assert.equal(result.errorMessage, "quota exhausted");
			// Escalated to preserve semantics.
			assert.equal(running.errorPanePreserved, true, "pane preserved after a failed close");
			assert.equal(running.errorPaneMonitorStarted, true, "the pane monitor was started");
			// The session lease stays held — the pane may still hold a live writer,
			// so the advertised resume must remain blocked.
			assert.ok(registry.get(sessionFile), "session lease retained until confirmed pane absence");
			assert.throws(() => registry.acquire(sessionFile, "concurrent-writer", "starting"), /already/);
		});
	});

	it("keeps the lease live for the delivery continuation (blocking shape), then releases", async () => {
		await withDir("reap-lease-order-", async (dir) => {
			const handoffs: ScriptHandoff[] = [];
			const service = createLaunchService({ handoffs });
			const sessionFile = join(dir, "order-run.jsonl");
			writeFileSync(sessionFile, "");
			const registry = getSessionLeaseRegistry(PARENT);
			const sessionLease = registry.acquire(sessionFile, "order-run", "running");
			const running = makeRunning(dir, "order-run", {
				sessionFile,
				maxAttempts: 1, // settle at attempt 1 without relaunching
				inspectPaneOverride: async () => ({ kind: "missing", error: "pane_not_found" }),
				sessionLease,
			});
			writeSidecar(sessionFile, "order-run", "Anthropic 529 Overloaded");

			const result = await service.watchSubagent(running, new AbortController().signal, {
				releaseOwnership: false, // the blocking watcher shape
				timeoutMs: 5_000,
			});

			assert.equal(result.errorMessage, "Anthropic 529 Overloaded");
			assert.equal(result.attempts, 1);
			assert.equal(result.maxAttempts, 1);
			assert.equal(result.permanentError, undefined);
			// The watcher ran with releaseOwnership: false (blocking shape): the
			// lease must still be live right after settlement so the delivery
			// continuation can transition it — exactly like a successful blocking run.
			assert.doesNotThrow(
				() => sessionLease.transition("finalizing"),
				"the continuation may transition the live lease (no released-lease throw)",
			);
			assert.equal(registry.get(sessionFile), sessionLease, "lease held until the continuation releases it");
			// And the continuation's tail (completeBlockingRun's release) clears it.
			sessionLease.release();
			assert.equal(registry.get(sessionFile), undefined);
		});
	});

	it(
		"keeps relaunch-failure and watch-abandoned panes preserved with leases retained",
		{ timeout: 90_000 },
		async () => {
			await withDir("reap-carveouts-", async (dir) => {
				const handoffs: ScriptHandoff[] = [];
				const service = createLaunchService({ handoffs });
				const registry = getSessionLeaseRegistry(PARENT);

				// Relaunch-mechanics failure: the failed attempt's pane NEVER reports
				// missing, so absence is never confirmed and the relaunch aborts
				// through settleRelaunchFailure (preserving the surviving pane).
				const relaunchSession = join(dir, "relaunch-fail.jsonl");
				writeFileSync(relaunchSession, "");
				const relaunchLease = registry.acquire(relaunchSession, "relaunch-fail", "running");
				const relaunchRunning = makeRunning(dir, "relaunch-fail", {
					sessionFile: relaunchSession,
					agentDefinition: reviewerDefinition,
					launchParams: { agent: "reviewer", task: "review", label: "reviewer" },
					effectiveCwd: dir,
					agentDir: dir,
					projectTrusted: true,
					inspectPaneOverride: async () => ({ kind: "present", agentStatus: "idle", observedAt: Date.now() }),
					sessionLease: relaunchLease,
				});
				writeSidecar(relaunchSession, "relaunch-fail", "Anthropic 529 Overloaded");

				const relaunchResult = await service.watchSubagent(relaunchRunning, new AbortController().signal, {
					releaseOwnership: false,
					timeoutMs: 80_000,
				});

				assert.match(String(relaunchResult.error ?? ""), /still present/);
				assert.equal(
					relaunchResult.errorMessage,
					undefined,
					"extension mechanics failure, not a provider error",
				);
				// The surviving pane keeps its lease until confirmed pane absence —
				// a live writer may persist, so the failure-settlement reap rule must
				// NOT fire on this path. The observable invariant: the session stays
				// exclusive (no concurrent writer can be unlocked), exactly as before.
				assert.ok(
					registry.get(relaunchSession),
					"relaunch-failure session lease retained until confirmed pane absence",
				);
				assert.throws(() => registry.acquire(relaunchSession, "concurrent-writer", "starting"), "already");

				// Watch-abandoned: the pane stays present and no evidence ever lands.
				const abandonedSession = join(dir, "abandoned-run.jsonl");
				writeFileSync(abandonedSession, "");
				const abandonedLease = registry.acquire(abandonedSession, "abandoned-run", "running");
				const abandonedRunning = makeRunning(dir, "abandoned-run", {
					sessionFile: abandonedSession,
					completionTimeoutMs: 40,
					inspectPaneOverride: async () => ({
						kind: "present",
						agentStatus: "working",
						observedAt: Date.now(),
					}),
					sessionLease: abandonedLease,
				});

				const abandonedResult = await service.watchSubagent(abandonedRunning, new AbortController().signal, {
					releaseOwnership: false,
				});

				assert.equal(abandonedResult.watchAbandoned, true);
				// The watch probe reports the pane present (via the override), so the
				// run settles as an abandoned watch — never as a settled error. The
				// pane-preservation flag depends on the sync probe against a real pane
				// id, which reports missing for the fake pane and falls through to the
				// close/reap branch — the durable invariant is the retained lease:
				// the watch-abandoned run must NOT be treated as a settled child error.
				assert.ok(
					registry.get(abandonedSession),
					"watch-abandoned session lease retained until pane disappearance",
				);
			});
		},
	);
});

describe("quota short-circuit retry policy", () => {
	it("settles a quota-pattern sidecar immediately with zero retries", async () => {
		await withDir("quota-immediate-", async (dir) => {
			const handoffs: ScriptHandoff[] = [];
			const service = createLaunchService({ handoffs });
			const running = makeRunning(dir, "quota-run", {
				inspectPaneOverride: async () => ({ kind: "missing", error: "pane_not_found" }),
			});
			writeSidecar(running.sessionFile, "quota-run", "quota exhausted");

			const result = await service.watchSubagent(running, new AbortController().signal, {
				releaseOwnership: false,
				timeoutMs: 10_000,
			});

			// Zero relaunches: the attempt-1 sidecar settled the run.
			assert.equal(handoffs.length, 0, "no relaunch script may be written for a permanent error");
			assert.equal(running.attempt, 1, "attempt count never advanced");
			assert.equal(result.attempts, 1, "attempt-accurate: one attempt ran");
			assert.equal(result.maxAttempts, undefined, "no exhaustion claim");
			assert.equal(result.permanentError, true);
			// The delivery composition states the short-circuit attempt-accurately.
			const presentation = presentedResult(result, running);
			assert.match(presentation, /no further automatic retry attempted because the error looked permanent/);
			assert.doesNotMatch(presentation, /auto-retry exhausted/);
			assert.match(presentation, /subagent\(\{ agent: "reviewer"/);
		});
	});

	it(
		"stamps permanentError and the attempt-accurate qualifier when the pattern first matches on attempt 2",
		{ timeout: 60_000 },
		async () => {
			await withDir("quota-later-attempt-", async (dir) => {
				const handoffs: ScriptHandoff[] = [];
				const sessionFile = join(dir, "late-quota.jsonl");
				// childDead tracks which attempt's pane is dead: attempt 1's sidecar is
				// already on disk (child dead); a relaunch's pane dies when its
				// hook-written sidecar lands.
				let childDead = true;
				const service = createLaunchService({
					handoffs,
					onRelaunchScript: (attemptId) => {
						// Attempt 2's relaunch fails with a quota error — the pattern first
						// matches after one retry already ran.
						writeSidecar(sessionFile, attemptId, "quota exhausted");
						childDead = true;
					},
				});
				const running = makeRunning(dir, "late-quota", {
					sessionFile,
					agentDefinition: reviewerDefinition,
					launchParams: { agent: "reviewer", task: "review", label: "reviewer" },
					effectiveCwd: dir,
					agentDir: dir,
					projectTrusted: true,
				});
				// Attempt 1 fails with a transient (retryable) overload.
				writeSidecar(sessionFile, "late-quota", "Anthropic 529 Overloaded");
				let relaunches = 0;
				running.attachSurfaceOverride = async () => {
					relaunches += 1;
					childDead = false; // the replacement pane is alive
					return { paneId: `pane-late-${relaunches}` };
				};
				running.inspectPaneOverride = async () =>
					childDead
						? { kind: "missing", error: "pane_not_found" }
						: { kind: "present", agentStatus: "working", observedAt: Date.now() };

				const result = await service.watchSubagent(running, new AbortController().signal, {
					releaseOwnership: false,
					timeoutMs: 60_000,
				});

				assert.equal(relaunches, 1, "exactly one relaunch ran (attempt 2)");
				assert.equal(running.attempt, 2);
				assert.equal(result.errorMessage, "quota exhausted");
				assert.equal(result.permanentError, true, "late match still stamps the short-circuit");
				assert.equal(result.attempts, 2, "attempt-accurate count");
				assert.equal(result.maxAttempts, undefined, "no exhaustion claim — attempts remained");
				const presentation = presentedResult(result, running);
				assert.match(
					presentation,
					/no further automatic retry attempted after 1 earlier attempt because the error looked permanent/,
				);
				assert.doesNotMatch(presentation, /auto-retry exhausted/);
				assert.match(presentation, /subagent\(\{ agent: "reviewer"/);
			});
		},
	);

	it("keeps the full 3-attempt policy for an unrecognized transient error", { timeout: 90_000 }, async () => {
		await withDir("transient-full-policy-", async (dir) => {
			const handoffs: ScriptHandoff[] = [];
			const sessionFile = join(dir, "transient-3.jsonl");
			let childDead = true;
			const service = createLaunchService({
				handoffs,
				onRelaunchScript: (attemptId) => {
					// Every relaunched attempt fails again with the same transient error.
					writeSidecar(sessionFile, attemptId, "Anthropic 529 Overloaded");
					childDead = true;
				},
			});
			const running = makeRunning(dir, "transient-3", {
				sessionFile,
				agentDefinition: reviewerDefinition,
				launchParams: { agent: "reviewer", task: "review", label: "reviewer" },
				effectiveCwd: dir,
				agentDir: dir,
				projectTrusted: true,
			});
			writeSidecar(sessionFile, "transient-3", "Anthropic 529 Overloaded");
			let relaunches = 0;
			running.attachSurfaceOverride = async () => {
				relaunches += 1;
				childDead = false;
				return { paneId: `pane-transient-${relaunches}` };
			};
			running.inspectPaneOverride = async () =>
				childDead
					? { kind: "missing", error: "pane_not_found" }
					: { kind: "present", agentStatus: "working", observedAt: Date.now() };

			const result = await service.watchSubagent(running, new AbortController().signal, {
				releaseOwnership: false,
				timeoutMs: 80_000,
			});

			assert.equal(relaunches, 2, "attempts 2 and 3 both ran");
			assert.equal(running.attempt, 3);
			assert.equal(result.attempts, 3);
			assert.equal(result.maxAttempts, 3, "full policy preserved for a classifier miss");
			assert.equal(result.permanentError, undefined);
			const presentation = presentedResult(result, running);
			assert.match(presentation, /auto-retry exhausted after 3 attempts/);
			assert.match(presentation, /subagent\(\{ agent: "reviewer"/);
		});
	});
});

// ── 4.3: the blocking path ──

describe("failed blocking run carries the resume-first presentation", () => {
	it("composes the tool result through the same presentation with the canonical agent id", async () => {
		await withDir("blocking-resume-", async (dir) => {
			const handoffs: ScriptHandoff[] = [];
			const service = createLaunchService({ handoffs });
			const sessionFile = join(dir, "blocking-fail.jsonl");
			writeFileSync(sessionFile, "");
			const registry = getSessionLeaseRegistry(PARENT);
			const sessionLease = registry.acquire(sessionFile, "blocking-fail", "running");
			const running = makeRunning(dir, "blocking-fail", {
				sessionFile,
				inspectPaneOverride: async () => ({ kind: "missing", error: "pane_not_found" }),
				sessionLease,
			});
			writeSidecar(sessionFile, "blocking-fail", "quota exhausted");

			// The blocking watcher shape: releaseOwnership false so the lease
			// lifecycle mirrors exactly what completeBlockingRun expects.
			const result = await service.watchSubagent(running, new AbortController().signal, {
				releaseOwnership: false,
				timeoutMs: 5_000,
			});

			// The blocking tool result composes the same resume-first shape as the
			// async steer, via the shared helper, with the run's canonical agent id.
			const toolResultText = presentedResult(result, running);
			assert.match(
				toolResultText,
				new RegExp(
					`subagent\\(\\{ agent: "reviewer", task: "${RESUME_TASK}", session: "${sessionFile.replace(/\//g, "\\/")}" }\\)`,
				),
			);
			assert.match(toolResultText, /do not resume and do not spawn a replacement/);
			assert.match(toolResultText, /no further automatic retry attempted because the error looked permanent/);
			// completeBlockingRun's ordering holds: the lease is live for the
			// "finalizing" transition, then released by the ownership tail.
			assert.doesNotThrow(() => sessionLease.transition("finalizing"));
			assert.equal(result.agent, "reviewer");
			assert.equal(result.permanentError, true);
			sessionLease.release();
			assert.equal(registry.get(sessionFile), undefined, "released after the continuation tail");
		});
	});
});

// ── 4.5: regression — sticky capture, admission eviction, delivery wiring ──

describe("failure delivery regressions", () => {
	it("captures a sticky ✗ row for a settled failed run and evicts it at the next admission", async () => {
		await withDir("sticky-failed-", async (dir) => {
			const handoffs: ScriptHandoff[] = [];
			const service = createLaunchService({ handoffs });
			const running = makeRunning(dir, "sticky-run", {
				inspectPaneOverride: async () => ({ kind: "missing", error: "pane_not_found" }),
			});
			writeSidecar(running.sessionFile, "sticky-run", "Anthropic 529 Overloaded");

			const result = await service.watchSubagent(running, new AbortController().signal, {
				releaseOwnership: false,
				timeoutMs: 5_000,
			});

			// The delivery tail captures the terminal row via captureStickyTerminalRun.
			const captured = service.captureStickyTerminalRun(running, result);
			assert.equal(captured, true, "a failed run still produces a sticky ✗ row");
			const sticky = testApi.stickyTerminalRuns.get("sticky-run");
			assert.ok(sticky, "row recorded");
			assert.equal(sticky.kind, "failed");
			assert.equal(sticky.agent, "reviewer");
			// The resume itself is an admission — admissions evict the sticky set,
			// so acting on the delivered instruction clears the row that gave it.
			service.clearStickyTerminalsOnAdmission();
			assert.equal(testApi.stickyTerminalRuns.size, 0, "evicted at next admission");
		});
	});

	it("delivers a failed background result through the steer path exactly once, with wake", async () => {
		// Mirrors the review-fixes delivery boundary tests: a failed background
		// run's message goes through deliverBackgroundMessage — dedup by run id,
		// one wake. The presentation is only the message content; the delivery
		// mechanics are unchanged by this change and must stay so.
		await withDir("background-once-", async (dir) => {
			const parentSessionFile = join(dir, "parent.jsonl");
			const runId = "bg-once-1";
			const sent: string[] = [];
			const wakes: string[] = [];
			const pi: any = {
				sendMessage(msg: any) {
					sent.push(msg.customType);
					// Persist the message so delivery verification acks it.
					appendFileSync(
						parentSessionFile,
						`${JSON.stringify({
							type: "custom_message",
							customType: msg.customType,
							content: msg.content,
							details: msg.details,
						})}\n`,
					);
				},
				sendUserMessage(content: unknown) {
					wakes.push(String(content));
				},
			};
			testApi.activateCompletionRuntime(pi, `parent-${runId}`);
			try {
				const message = {
					customType: "subagent_result",
					content: resolveResultPresentation(
						exhaustedResult({ sessionFile: join(dir, "child.jsonl") }),
						"Reviewer",
						runId,
						"reviewer",
					),
					display: true,
					details: {
						id: runId,
						name: "Reviewer",
						task: "review",
						agent: "reviewer",
						exitCode: 1,
						elapsed: 94,
					},
				};
				await testApi.deliverBackgroundMessage(pi, `parent-${runId}`, message, {
					sessionFile: parentSessionFile,
					expectedRunId: runId,
					graceMs: 1000,
				});
				// Exactly one subagent_result steer and one wake.
				assert.equal(sent.filter((t) => t === "subagent_result").length, 1, "delivered exactly once");
				assert.equal(wakes.length, 1, "one wake after confirmed delivery");
				assert.equal(wakes[0], testApi.WAKE_MESSAGE);
				// The delivered content is the resume-first presentation.
				// (The message content was composed above through the same helper the
				// delivery site uses — asserting it is resume-first here pins the
				// shape a failed background steer carries.)
				assert.match(message.content, /subagent\(\{ agent: "reviewer"/);
				assert.match(message.content, /do not resume and do not spawn a replacement/);
			} finally {
				testApi.deliveredRunIds.delete(runId);
				testApi.inflightDelivery.delete(runId);
				testApi.resetActiveCompletionRuntime();
			}
		});
	});

	it("background result message wiring threads the canonical agent id and short-circuit fields into details", () => {
		// Pin the composed details shape a failed background steer carries: the
		// backgroundResultDetails site passes running.agent (canonical), and the
		// widget renders the message without duplicating the first line.
		const result = exhaustedResult({ attempts: 1, maxAttempts: undefined, permanentError: true });
		const content = resolveResultPresentation(result, "Review Pass", "run-9", "reviewer");
		assert.match(content, /agent: "reviewer"/);
		const details = {
			id: "run-9",
			name: "Review Pass",
			task: "review",
			agent: "reviewer",
			exitCode: result.exitCode,
			elapsed: result.elapsed,
			sessionFile: result.sessionFile,
			errorMessage: result.errorMessage,
			attempts: result.attempts,
			maxAttempts: result.maxAttempts,
			permanentError: result.permanentError,
		};
		assert.equal(details.agent, "reviewer", "canonical id, not the label");
		assert.equal(details.permanentError, true);
		const rendered = renderSubagentResultMessage({ content, details }, { expanded: true }, theme, 140).join("\n");
		assert.match(rendered, /failed \(provider\/agent error\)/);
		assert.match(rendered, /subagent\(\{ agent: "reviewer"/);
		assert.doesNotMatch(rendered, /Sub-agent "Review Pass" \[run-9\] failed after/);
	});
});
