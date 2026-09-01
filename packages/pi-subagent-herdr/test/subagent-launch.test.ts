import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { AgentDefinition } from "../src/agent-definition.ts";
import type { CompletionResult } from "../src/completion.ts";
import { type AdmissionLease, getAdmissionCoordinator } from "../src/coordinator.ts";
import { finishLaunchTransaction, getLaunchTransactions } from "../src/launch-transaction.ts";
import { createLifecycle } from "../src/lifecycle.ts";
import type { ResolvedRuntimePlan } from "../src/runtime-routing.ts";
import { getSubagentArtifactDir } from "../src/session.ts";
import { runningSubagents, stickyTerminalRuns } from "../src/state.ts";
import { createSubagentLaunchService } from "../src/subagent-launch.ts";
import type { RunningSubagent, StableParentContext } from "../src/types.ts";

const definition: AgentDefinition = {
	id: "reviewer",
	sourcePath: "/agents/reviewer.md",
	source: "project",
	tools: "read,bash",
	body: "Review the launch handoff.",
	frontmatter: "",
};

const runtimePlan: ResolvedRuntimePlan = {
	provider: "acme",
	modelId: "model-1",
	model: "acme/model-1",
	thinking: "high",
	modelSource: "request",
	thinkingSource: "request",
};

type ScriptHandoff = {
	paneId: string;
	command: string;
	options?: { scriptPath?: string; scriptPreamble?: string };
};

function createService(handoffs: ScriptHandoff[], failHandoff = false) {
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
		createRunId: () => "unused-run-id",
		getShellReadyDelayMs: () => 0,
		getSubagentArtifactDir,
		runScriptInPane: (paneId, command, options) => {
			handoffs.push({ paneId, command, options });
			if (failHandoff) throw new Error("script handoff failed");
			const scriptPath = options?.scriptPath;
			if (!scriptPath) throw new Error("expected launch script path");
			mkdirSync(dirname(scriptPath), { recursive: true });
			writeFileSync(scriptPath, `#!/bin/bash\n${options?.scriptPreamble ?? ""}\n${command}\n`, { mode: 0o755 });
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

function launchContext(dir: string, sessionId: string): StableParentContext {
	const cwd = join(dir, "project");
	const sessionFile = join(dir, "parent.jsonl");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(sessionFile, '{"type":"session","id":"parent"}\n');
	return {
		cwd,
		agentDir: join(dir, "agent"),
		projectTrusted: true,
		sessionFile,
		sessionId,
	};
}

function launchOptions(runId: string, admissionLease: AdmissionLease) {
	return {
		agentDefinition: definition,
		selectedSkills: [
			{
				name: "launch-skill",
				description: "A launch test skill",
				filePath: "/skills/launch/SKILL.md",
				baseDir: "/skills/launch",
				disableModelInvocation: false,
			},
		],
		runtimePlan,
		runId,
		admissionClass: "foreground" as const,
		admissionLease,
		projectTrusted: true,
		surface: "pane-direct-launch",
	};
}

function cleanupRun(
	runId: string,
	running?: Pick<RunningSubagent, "launchTransaction" | "sessionLease" | "admissionLease">,
): void {
	const transaction = running?.launchTransaction;
	transaction?.rollback();
	if (transaction) finishLaunchTransaction(runId, transaction);
	running?.sessionLease?.release();
	running?.admissionLease?.release();
	runningSubagents.delete(runId);
	stickyTerminalRuns.delete(runId);
}

describe("direct subagent launch path", () => {
	it("seeds a child session, writes launch artifacts, hands the command to the supplied pane, and commits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-launch-"));
		const runId = "direct-launch-run";
		const sessionId = "direct-launch-parent";
		const handoffs: ScriptHandoff[] = [];
		const service = createService(handoffs);
		const context = launchContext(dir, sessionId);
		const admissionLease = getAdmissionCoordinator(sessionId).request({ id: runId, class: "foreground" }).lease;
		let running: RunningSubagent | undefined;

		try {
			running = await service.launchSubagent(
				{ agent: "reviewer", label: "Launch label", task: "Inspect the direct launch path." },
				context,
				launchOptions(runId, admissionLease),
			);

			assert.equal(running.id, runId);
			assert.equal(running.name, "Launch label");
			assert.equal(running.agent, "reviewer");
			assert.equal(running.parentSessionId, sessionId);
			assert.equal(running.surface, "pane-direct-launch");
			assert.equal(running.entryCountBefore, 2);
			assert.equal(running.sessionLease?.state, "running");
			assert.equal(runningSubagents.get(runId), running);
			assert.equal(existsSync(running.sessionFile), true);
			assert.equal(existsSync(`${running.sessionFile}.owner.json`), false);

			const lines = readFileSync(running.sessionFile, "utf8").trim().split("\n");
			const sessionHeader = JSON.parse(lines[0]);
			assert.equal(sessionHeader.type, "session");
			assert.equal(sessionHeader.cwd, context.cwd);
			assert.equal(sessionHeader.parentSession, context.sessionFile);
			assert.equal(sessionHeader.subagentOwner.agentId, "reviewer");
			assert.equal(sessionHeader.subagentOwner.parentSessionId, sessionId);

			const sessionInfo = JSON.parse(lines[1]);
			assert.equal(sessionInfo.type, "session_info");
			assert.equal(sessionInfo.name, "Launch label");

			assert.equal(handoffs.length, 1);
			const handoff = handoffs[0];
			assert.equal(handoff.paneId, "pane-direct-launch");
			assert.equal(handoff.options?.scriptPath, running.launchScriptFile);
			assert.ok(handoff.command.includes(`--session '${running.sessionFile}'`));
			assert.match(handoff.command, /--model 'acme\/model-1'/);
			assert.match(handoff.command, /--thinking 'high'/);
			assert.match(handoff.command, /--tools 'read,bash,subagent_done'/);
			assert.match(handoff.command, /--no-skills --skill '\/skills\/launch\/SKILL.md'/);
			assert.match(handoff.command, /PI_SUBAGENT_SELECTED_SKILLS=/);
			assert.match(handoff.command, /PI_SUBAGENT_SURFACE='pane-direct-launch'/);
			const launchScriptFile = running.launchScriptFile;
			assert.ok(launchScriptFile);
			assert.equal(existsSync(launchScriptFile), true);

			const script = readFileSync(launchScriptFile, "utf8");
			assert.match(script, /# Subagent launch script for reviewer/);
			assert.match(script, /# Run: direct-launch-run/);
			assert.match(script, /# Surface: pane-direct-launch/);

			const artifactDir = getSubagentArtifactDir(running.sessionFile);
			const systemPromptFile = join(artifactDir, "sysprompt.md");
			const taskFile = join(artifactDir, "task.md");
			assert.equal(running.launchScriptFile, join(artifactDir, "launch.sh"));
			assert.equal(statSync(artifactDir).mode & 0o777, 0o700);
			assert.equal(
				readFileSync(systemPromptFile, "utf8"),
				'<active_agent name="reviewer"/>\nReview the launch handoff.',
			);
			assert.equal(
				readFileSync(taskFile, "utf8"),
				"Complete your task autonomously.\n\nInspect the direct launch path.\n\n" +
					"Your FINAL assistant message should summarize what you accomplished.",
			);
			assert.ok(handoff.command.includes(`@${taskFile}`));

			assert.equal(getLaunchTransactions().has(runId), true);
			service.commitRunningLaunch(running);
			assert.equal(running.launchTransaction, undefined);
			assert.equal(getLaunchTransactions().has(runId), false);
		} finally {
			cleanupRun(runId, running);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resumes a caller-supplied session without re-seeding or registering rollbacks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-resume-launch-"));
		const runId = "resume-launch-run";
		const sessionId = "resume-launch-parent";
		const handoffs: ScriptHandoff[] = [];
		const service = createService(handoffs);
		const context = launchContext(dir, sessionId);
		const admissionLease = getAdmissionCoordinator(sessionId).request({ id: runId, class: "foreground" }).lease;
		let running: RunningSubagent | undefined;

		try {
			// Pre-existing caller-supplied session with a preserved transcript.
			const sessionDir = join(
				context.agentDir,
				"sessions",
				`--${context.cwd.replace(/^\//, "").replace(/\//g, "-")}--`,
			);
			mkdirSync(sessionDir, { recursive: true });
			const resumeFile = join(sessionDir, "2026-01-01T00-00-00-000Z-resumed-abc.jsonl");
			const transcript = [
				JSON.stringify({
					type: "session",
					id: "child-1",
					subagentOwner: { agentId: "reviewer", parentSessionId: sessionId },
				}),
				JSON.stringify({
					type: "message",
					id: "m-1",
					message: { role: "user", content: [{ type: "text", text: "earlier" }] },
				}),
			].join("\n");
			writeFileSync(resumeFile, `${transcript}\n`);
			const artifactDir = getSubagentArtifactDir(resumeFile);
			mkdirSync(artifactDir, { recursive: true });
			writeFileSync(join(artifactDir, "pre-existing.txt"), "keep me\n");

			running = await service.launchSubagent(
				{ agent: "reviewer", label: "Resume label", task: "Continue." },
				context,
				{ ...launchOptions(runId, admissionLease), resumeSessionFile: resumeFile },
			);

			assert.equal(running.sessionFile, resumeFile);
			assert.equal(running.resumed, true);
			// The transcript is preserved verbatim: no re-seed, no truncation.
			assert.equal(readFileSync(resumeFile, "utf8"), `${transcript}\n`);
			// entryCountBefore scopes result extraction to the resumed turn.
			assert.equal(running.entryCountBefore, 2);
			// Release the foreground slot so the failing launch can be admitted.
			cleanupRun(runId, running);
			running = undefined;

			// A post-seed launch failure (handoff failure) rolls back WITHOUT
			// deleting the caller-supplied session file or its companion dir.
			const failingLease = getAdmissionCoordinator(sessionId).request({
				id: "resume-launch-fail",
				class: "foreground",
			}).lease;
			const failing = createService([], true);
			await assert.rejects(
				failing.launchSubagent({ agent: "reviewer", task: "This handoff fails." }, context, {
					...launchOptions("resume-launch-fail", failingLease),
					resumeSessionFile: resumeFile,
				}),
				/script handoff failed/,
			);
			assert.equal(existsSync(resumeFile), true, "caller-supplied session file survives a failed launch");
			assert.equal(
				existsSync(join(artifactDir, "pre-existing.txt")),
				true,
				"pre-existing companion directory content survives a failed launch",
			);
		} finally {
			cleanupRun(runId, running);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("releases the admission and records a sticky failure when background handoff fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-launch-failure-"));
		const runId = "background-launch-failure";
		const sessionId = "background-launch-parent";
		const handoffs: ScriptHandoff[] = [];
		const service = createService(handoffs, true);
		const context = launchContext(dir, sessionId);
		const admissionLease = getAdmissionCoordinator(sessionId).request({ id: runId, class: "background" }).lease;

		try {
			await assert.rejects(
				service.startBackgroundSpawn({
					params: { agent: "reviewer", label: "Background label", task: "This handoff fails." },
					ctx: context,
					agentDefinition: definition,
					selectedSkills: [],
					runtimePlan,
					runId,
					admissionLease,
					projectTrusted: true,
					surface: "pane-background-failure",
				}),
				/script handoff failed/,
			);

			assert.equal(handoffs.length, 1);
			assert.equal(runningSubagents.has(runId), false);
			assert.equal(admissionLease.state, "released");
			const sticky = stickyTerminalRuns.get(runId);
			assert.ok(sticky);
			assert.equal(sticky.id, runId);
			assert.equal(sticky.name, "Background label");
			assert.equal(sticky.agent, "reviewer");
			assert.equal(sticky.admissionClass, "background");
			assert.equal(sticky.startTime, admissionLease.admittedAt);
			assert.equal(sticky.kind, "failed");
			assert.equal(sticky.runtimeEndedAt, sticky.capturedAt);
			assert.equal(getLaunchTransactions().has(runId), false);
			// Task 2.3: a failed launch rolls back BOTH the child .jsonl and its
			// companion directory — nothing listable or stray survives the failure.
			assert.equal(existsSync(join(dir, "session-data")), false, "no leftover session data");
		} finally {
			cleanupRun(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("settlement artifact disposition", () => {
	const service = createService([]);

	function makeRunning(dir: string, id: string) {
		const sessionFile = join(dir, `${id}.jsonl`);
		writeFileSync(sessionFile, "");
		const artifactDir = getSubagentArtifactDir(sessionFile);
		mkdirSync(artifactDir, { recursive: true });
		for (const name of ["launch.sh", "task.md", "sysprompt.md", "activity.json"]) {
			writeFileSync(join(artifactDir, name), "x\n");
		}
		const running: RunningSubagent = {
			id,
			name: "reviewer",
			task: "review",
			surface: `pane-${id}`,
			startTime: Date.now(),
			sessionFile,
			lifecycle: createLifecycle(Date.now()),
			runtimePlan: undefined,
			entryCountBefore: 0,
		};
		return { running, artifactDir };
	}

	function withDir(name: string, run: (dir: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), name));
		try {
			run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("deletes <stem>/ on an owned sidecar success, keeping the transcript", () => {
		withDir("settle-sidecar-success-", (dir) => {
			const { running, artifactDir } = makeRunning(dir, "sidecar-ok");
			service.applySettlementDisposition(running, { reason: "done", exitCode: 0, runId: "sidecar-ok" });
			assert.equal(existsSync(artifactDir), false, "owned sidecar success deletes <stem>/");
			assert.equal(existsSync(running.sessionFile), true, "the transcript is never deleted");
		});
	});

	it("deletes <stem>/ on a sentinel exit-zero success", () => {
		withDir("settle-sentinel-success-", (dir) => {
			const { running, artifactDir } = makeRunning(dir, "sentinel-ok");
			// Sentinel results carry no runId — they bind via the run's own pane tail.
			service.applySettlementDisposition(running, { reason: "sentinel", exitCode: 0 });
			assert.equal(existsSync(artifactDir), false, "sentinel exit zero deletes <stem>/");
			assert.equal(existsSync(running.sessionFile), true);
		});
	});

	it("preserves <stem>/ for a nonzero sentinel exit", () => {
		withDir("settle-sentinel-failure-", (dir) => {
			const { running, artifactDir } = makeRunning(dir, "sentinel-fail");
			service.applySettlementDisposition(running, { reason: "sentinel", exitCode: 7 });
			assert.equal(existsSync(artifactDir), true, "nonzero sentinel preserves <stem>/");
			assert.equal(existsSync(join(artifactDir, "launch.sh")), true);
		});
	});

	it("preserves <stem>/ for a sidecar success lacking or mismatching the run id (fail-closed)", () => {
		withDir("settle-sidecar-foreign-", (dir) => {
			const { running, artifactDir } = makeRunning(dir, "sidecar-foreign");
			service.applySettlementDisposition(running, { reason: "done", exitCode: 0 });
			assert.equal(existsSync(artifactDir), true, "absent runId preserves");
			service.applySettlementDisposition(running, { reason: "done", exitCode: 0, runId: "other-run" });
			assert.equal(existsSync(artifactDir), true, "mismatched runId preserves");
		});
	});

	it("preserves <stem>/ for error and timeout outcomes", () => {
		withDir("settle-preserved-", (dir) => {
			const { running, artifactDir } = makeRunning(dir, "preserved");
			service.applySettlementDisposition(running, { reason: "error", exitCode: 1, errorMessage: "boom" });
			assert.equal(existsSync(artifactDir), true, "error preserves <stem>/");
			const { running: abandoned, artifactDir: abandonedDir } = makeRunning(dir, "abandoned");
			service.applySettlementDisposition(abandoned, { reason: "timeout", exitCode: 1 });
			assert.equal(existsSync(abandonedDir), true, "timeout preserves <stem>/");
		});
	});

	it("keys sidecar-success deletion on the CURRENT attempt id, not the run id", () => {
		withDir("settle-attempt-id-", (dir) => {
			const { running, artifactDir } = makeRunning(dir, "attempt-run");
			// A retried run: attemptId is regenerated while the run id is stable.
			running.attemptId = "attempt-run-r2";
			// A sidecar stamped with the current attempt id deletes.
			service.applySettlementDisposition(running, { reason: "done", exitCode: 0, runId: "attempt-run-r2" });
			assert.equal(existsSync(artifactDir), false, "current-attempt sidecar success deletes <stem>/");
		});
		withDir("settle-attempt-id-stale-", (dir) => {
			const { running, artifactDir } = makeRunning(dir, "attempt-run-2");
			running.attemptId = "attempt-run-2-r2";
			// A stale comparand (the original run id) fail-closes deletion.
			service.applySettlementDisposition(running, { reason: "done", exitCode: 0, runId: "attempt-run-2" });
			assert.equal(existsSync(artifactDir), true, "stale runId comparand preserves <stem>/");
		});
	});

	it("exposes the delete decision on resolveSettlementDisposition for every channel", () => {
		const deletes = (
			result: { reason: CompletionResult["reason"]; exitCode: number; runId?: string },
			id = "run-1",
		) => !service.resolveSettlementDisposition(result, id).preserveArtifacts;
		assert.equal(deletes({ reason: "done", exitCode: 0, runId: "run-1" }), true, "owned sidecar success");
		assert.equal(deletes({ reason: "sentinel", exitCode: 0 }), true, "sentinel exit zero");
		assert.equal(deletes({ reason: "sentinel", exitCode: 7 }), false, "nonzero sentinel");
		assert.equal(deletes({ reason: "done", exitCode: 0 }), false, "sidecar without run id");
		assert.equal(deletes({ reason: "done", exitCode: 0, runId: "other" }), false, "foreign run id");
		assert.equal(deletes({ reason: "error", exitCode: 1 }), false, "error");
		assert.equal(deletes({ reason: "timeout", exitCode: 1 }), false, "timeout");
	});
});
