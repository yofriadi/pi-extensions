import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { AgentDefinition } from "../src/agent-definition.ts";
import { type AdmissionLease, getAdmissionCoordinator } from "../src/coordinator.ts";
import { finishLaunchTransaction, getLaunchTransactions } from "../src/launch-transaction.ts";
import { createLifecycle } from "../src/lifecycle.ts";
import type { ResolvedRuntimePlan } from "../src/runtime-routing.ts";
import { runningSubagents, stickyTerminalRuns } from "../src/state.ts";
import { createSubagentLaunchService } from "../src/subagent-launch.ts";
import type { RunningSubagent, StableParentContext } from "../src/types.ts";

const definition: AgentDefinition = {
	id: "reviewer",
	sourcePath: "/agents/reviewer.md",
	source: "project",
	tools: "read,bash",
	seed: "fresh",
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
			seed: "fresh",
			inheritsConversationContext: false,
			taskDelivery: "artifact",
		}),
		lifecycleDenySet: () => new Set(["subagent"]),
		buildSystemPromptFileContent: ({ agentName, identity }) => ({
			content: `<active_agent name="${agentName}"/>\n${identity}`,
			flag: "--append-system-prompt",
		}),
		buildSubagentToolAllowlist: (tools) => `${tools},subagent_done`,
		buildLaunchArtifactName: (agent, timestamp, runId) => `${agent}-${timestamp}-${runId}.md`,
		safeCommentValue: (value) => value.replace(/[\r\n]/g, " ").trim(),
		createRunId: () => "unused-run-id",
		getArtifactDir: (sessionDir, sessionId) => join(sessionDir, "artifacts", sessionId),
		getShellReadyDelayMs: () => 0,
		getSubagentActivityFile: (artifactDir, runId) => join(artifactDir, "activity", `${runId}.json`),
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
		sessionDir: join(dir, "session-data"),
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
			assert.equal(existsSync(`${running.sessionFile}.owner.json`), true);

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

			const contextDir = join(context.sessionDir, "artifacts", sessionId, "context");
			const contextArtifacts = readdirSync(contextDir);
			const promptArtifact = contextArtifacts.find((name) => name.includes("-sysprompt-"));
			const taskArtifact = contextArtifacts.find(
				(name) => name.startsWith("reviewer-") && !name.includes("-sysprompt-"),
			);
			assert.ok(promptArtifact, "system prompt artifact was written");
			assert.ok(taskArtifact, "task artifact was written");
			assert.equal(
				readFileSync(join(contextDir, promptArtifact), "utf8"),
				'<active_agent name="reviewer"/>\nReview the launch handoff.',
			);
			assert.equal(
				readFileSync(join(contextDir, taskArtifact), "utf8"),
				"Complete your task autonomously.\n\nInspect the direct launch path.\n\n" +
					"Your FINAL assistant message should summarize what you accomplished.",
			);
			assert.ok(handoff.command.includes(`@${join(contextDir, taskArtifact)}`));

			assert.equal(getLaunchTransactions().has(runId), true);
			service.commitRunningLaunch(running);
			assert.equal(running.launchTransaction, undefined);
			assert.equal(getLaunchTransactions().has(runId), false);
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
		} finally {
			cleanupRun(runId);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
