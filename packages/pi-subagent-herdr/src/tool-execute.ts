import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentDefinition, loadAgentDefinition } from "./agent-definition.ts";
import { getAdmissionCoordinator } from "./coordinator.ts";
import {
	deliverBackgroundMessage,
	isSessionRuntimeUnavailable,
	queuePendingDeliveryWithVerification,
	startDeliveryRetry,
} from "./delivery.ts";
import { getForegroundDeliveryBarrier } from "./delivery-barrier.ts";
import { finishLaunchTransaction } from "./launch-transaction.ts";
import { markDelivery } from "./lifecycle.ts";
import { resolveRuntimePlan, type ThinkingLevel, wrapPiModelRegistry } from "./runtime-routing.ts";
import { resolveSelectedSkills, type SelectedSkill } from "./skills.ts";
import { queuedSubagents, runningSubagents } from "./state.ts";
import { isTerminalAvailable, terminalSetupHint } from "./terminal.ts";
import type { QueuedSubagent, RunningSubagent, StableParentContext, SubagentResult } from "./types.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type AdmissionTicket = ReturnType<ReturnType<typeof getAdmissionCoordinator>["request"]>;
type RuntimePlan = ReturnType<typeof resolveRuntimePlan>;
type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

type ToolExecuteDeps = {
	snapshotParentContext: (ctx: ExtensionContext) => StableParentContext;
	resolveBlocking: (params: any) => boolean;
	createRunId: () => string;
	clearStickyTerminalsOnAdmission: () => void;
	startBackgroundSpawn: (options: {
		params: any;
		ctx: StableParentContext;
		agentDefinition: AgentDefinition;
		selectedSkills: SelectedSkill[];
		runtimePlan: RuntimePlan;
		runId: string;
		admissionLease: AdmissionTicket["lease"];
		projectTrusted: boolean;
	}) => Promise<RunningSubagent>;
	captureStickyLaunchFailure: (params: {
		id: string;
		name: string;
		agent?: string;
		admissionClass?: "foreground" | "background";
		startTime: number;
		error: unknown;
	}) => void;
	launchSubagent: (
		params: any,
		ctx: StableParentContext,
		options: {
			agentDefinition: AgentDefinition;
			selectedSkills: SelectedSkill[];
			runtimePlan: RuntimePlan;
			runId?: string;
			admissionClass?: "foreground" | "background";
			admissionLease?: AdmissionTicket["lease"];
			projectTrusted?: boolean;
		},
	) => Promise<RunningSubagent>;
	watchSubagent: (
		running: RunningSubagent,
		signal: AbortSignal,
		options: { releaseOwnership?: boolean; timeoutMs?: number },
	) => Promise<SubagentResult>;
	commitRunningLaunch: (running: RunningSubagent) => void;
	failLaunch: (running: RunningSubagent, error: unknown, aborted: boolean) => void;
	releaseRunOwnership: (running: RunningSubagent) => void;
	captureStickyTerminalRun: (running: RunningSubagent, result: SubagentResult) => boolean;
	updateWidget: () => void;
	startWidgetRefresh: () => void;
	startStatusRefresh: () => void;
	appendLayoutWarning: (text: string, warning?: string) => string;
	resolveResultPresentation: (result: SubagentResult, name: string, runId?: string) => string;
	shouldDeliverSubagentCompletion: (running: RunningSubagent) => boolean;
	/** Injectable only to exercise the tool path without a live Herdr binary. */
	isTerminalAvailable?: () => boolean;
	terminalSetupHint?: () => string;
};

type CallContext = {
	pi: ExtensionAPI;
	params: any;
	signal: any;
	ctx: ExtensionContext;
};

type ResolvedLaunchContext = {
	stableCtx: StableParentContext;
	agentDefinition: AgentDefinition;
	selectedSkills: SelectedSkill[];
	runtimePlan: RuntimePlan;
};

type Admission = {
	blocking: boolean;
	admissionClass: "foreground" | "background";
	runId: string;
	parentSessionId: string;
	runtimePlan: RuntimePlan;
	ticket: AdmissionTicket;
	foregroundBarrierLease: ReturnType<ReturnType<typeof getForegroundDeliveryBarrier>["enter"]> | undefined;
};

export function createToolExecute(deps: ToolExecuteDeps) {
	return async function executeSubagentTool(
		pi: ExtensionAPI,
		_toolCallId: any,
		params: any,
		signal: any,
		_onUpdate: any,
		ctx: ExtensionContext,
	): Promise<ToolResult> {
		const call = { pi, params, signal, ctx };
		const resolved = await resolveLaunchContext(deps, call);
		if ("result" in resolved) return resolved.result;
		const unavailable = validateExecutionEnvironment(deps, resolved.stableCtx);
		if (unavailable) return unavailable;
		return runAdmittedLaunch(deps, call, resolved);
	};
}

async function resolveLaunchContext(
	deps: ToolExecuteDeps,
	call: CallContext,
): Promise<ResolvedLaunchContext | { result: ToolResult }> {
	const stableCtx = deps.snapshotParentContext(call.ctx);
	try {
		const agentDefinition = loadAgentDefinition({
			id: call.params.agent,
			cwd: stableCtx.cwd,
			agentDir: stableCtx.agentDir,
			projectTrusted: stableCtx.projectTrusted,
		});
		const runtimePlan = resolveChildRuntimePlan(call.pi, call.ctx, agentDefinition);
		const selectedSkills = await resolveSelectedSkills({
			raw: agentDefinition.skills,
			cwd: stableCtx.cwd,
			agentDir: stableCtx.agentDir,
			projectTrusted: stableCtx.projectTrusted,
		});
		return { stableCtx, agentDefinition, selectedSkills, runtimePlan };
	} catch (error) {
		return { result: failureResult(error) };
	}
}

function validateExecutionEnvironment(deps: ToolExecuteDeps, stableCtx: StableParentContext): ToolResult | undefined {
	if (!(deps.isTerminalAvailable ?? isTerminalAvailable)()) {
		const hint = (deps.terminalSetupHint ?? terminalSetupHint)();
		return toolResult(`Subagents require herdr. ${hint}`, "herdr not available");
	}
	if (!stableCtx.sessionFile) return toolResult("Error: no session file.", "no session file");
	if (!process.env.HERDR_PANE_ID) return toolResult("Error: HERDR_PANE_ID not set", "missing HERDR_PANE_ID", true);
	return undefined;
}

async function runAdmittedLaunch(
	deps: ToolExecuteDeps,
	call: CallContext,
	context: ResolvedLaunchContext,
): Promise<ToolResult> {
	const admission = beginAdmission(deps, call, context);
	const queuedResult = await handleQueuedAdmission(deps, call, context, admission);
	if (queuedResult) return queuedResult;
	const cancellation = await awaitAdmission(deps, admission);
	if (cancellation) return cancellation;
	return launchAdmittedRun(deps, call, context, admission);
}

async function handleQueuedAdmission(
	deps: ToolExecuteDeps,
	call: CallContext,
	context: ResolvedLaunchContext,
	admission: Admission,
): Promise<ToolResult | undefined> {
	if (!admission.ticket.queued) return undefined;
	if (!admission.blocking) return queueBackgroundLaunch(deps, call, context, admission);
	queueForegroundLaunch(deps, call.params, admission);
	return undefined;
}

function launchAdmittedRun(
	deps: ToolExecuteDeps,
	call: CallContext,
	context: ResolvedLaunchContext,
	admission: Admission,
): Promise<ToolResult> {
	deps.clearStickyTerminalsOnAdmission();
	queuedSubagents.delete(admission.runId);
	deps.updateWidget();
	if (admission.blocking) return runBlockingLaunch(deps, call, context, admission);
	return runBackgroundLaunch(deps, call.params, context, admission);
}

function beginAdmission(deps: ToolExecuteDeps, call: CallContext, context: ResolvedLaunchContext): Admission {
	const blocking = deps.resolveBlocking(call.params);
	const admissionClass = blocking ? "foreground" : "background";
	const runId = deps.createRunId();
	const parentSessionId = context.stableCtx.sessionId;
	const foregroundBarrierLease = createForegroundBarrierLease(blocking, parentSessionId, runId);
	const ticket = requestAdmission(
		parentSessionId,
		runId,
		admissionClass,
		call.signal,
		blocking,
		foregroundBarrierLease,
	);
	return {
		blocking,
		admissionClass,
		runId,
		parentSessionId,
		runtimePlan: context.runtimePlan,
		ticket,
		foregroundBarrierLease,
	};
}

function createForegroundBarrierLease(blocking: boolean, parentSessionId: string, runId: string) {
	return blocking ? getForegroundDeliveryBarrier(parentSessionId).enter(runId) : undefined;
}

function requestAdmission(
	parentSessionId: string,
	runId: string,
	admissionClass: Admission["admissionClass"],
	signal: any,
	blocking: boolean,
	foregroundBarrierLease: Admission["foregroundBarrierLease"],
): AdmissionTicket {
	try {
		return getAdmissionCoordinator(parentSessionId).request({
			id: runId,
			class: admissionClass,
			...(blocking ? { signal } : {}),
		});
	} catch (error) {
		foregroundBarrierLease?.release();
		throw error;
	}
}

function resolveChildRuntimePlan(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentDefinition: AgentDefinition,
): RuntimePlan {
	const thinking = pi.getThinkingLevel();
	if (!THINKING_LEVELS.includes(thinking as ThinkingLevel))
		throw new Error(`Unsupported parent thinking level: ${thinking}`);
	if (!ctx.model) throw new Error("Subagent launch requires a resolved parent model");
	return resolveRuntimePlan(
		{},
		{ model: agentDefinition.model, thinking: agentDefinition.thinking as ThinkingLevel | undefined },
		{ provider: ctx.model.provider, modelId: ctx.model.id, thinking },
		wrapPiModelRegistry(ctx.modelRegistry),
	);
}

function queueBackgroundLaunch(
	deps: ToolExecuteDeps,
	call: CallContext,
	context: ResolvedLaunchContext,
	admission: Admission,
): ToolResult {
	const entry: QueuedSubagent = {
		id: admission.runId,
		name: displayName(call.params),
		agent: call.params.agent,
		admissionClass: "background",
		queuedAt: Date.now(),
		cancel: () => admission.ticket.lease.cancel(),
	};
	queuedSubagents.set(admission.runId, entry);
	deps.updateWidget();
	watchQueuedBackgroundAdmission(deps, call.params, context, admission);
	return {
		content: [
			{
				type: "text",
				text: `Sub-agent "${displayName(call.params)}" [${admission.runId}] queued for background admission; no pane or session has been created.`,
			},
		],
		details: {
			id: admission.runId,
			name: displayName(call.params),
			agent: call.params.agent,
			status: "queued",
			class: "background",
		},
	};
}

function watchQueuedBackgroundAdmission(
	deps: ToolExecuteDeps,
	params: any,
	context: ResolvedLaunchContext,
	admission: Admission,
): void {
	void admission.ticket.admitted
		.then(
			() => startQueuedBackgroundLaunch(deps, params, context, admission),
			() => rejectQueuedBackgroundLaunch(deps, admission),
		)
		.catch((error) => reportQueuedBackgroundFailure(params, context.stableCtx, admission, error))
		.catch(() => undefined);
}

function startQueuedBackgroundLaunch(
	deps: ToolExecuteDeps,
	params: any,
	context: ResolvedLaunchContext,
	admission: Admission,
): Promise<RunningSubagent> {
	queuedSubagents.delete(admission.runId);
	deps.updateWidget();
	deps.clearStickyTerminalsOnAdmission();
	return deps.startBackgroundSpawn({
		params,
		ctx: context.stableCtx,
		agentDefinition: context.agentDefinition,
		selectedSkills: context.selectedSkills,
		runtimePlan: admission.runtimePlan,
		runId: admission.runId,
		admissionLease: admission.ticket.lease,
		projectTrusted: context.stableCtx.projectTrusted,
	});
}

function rejectQueuedBackgroundLaunch(deps: ToolExecuteDeps, admission: Admission): never {
	queuedSubagents.delete(admission.runId);
	deps.updateWidget();
	throw new Error("Subagent admission cancelled.");
}

async function reportQueuedBackgroundFailure(
	params: any,
	stableCtx: StableParentContext,
	admission: Admission,
	error: unknown,
): Promise<void> {
	if (admission.ticket.lease.state === "cancelled") return;
	const message = queuedFailureMessage(params, admission.runId, error);
	try {
		await deliverBackgroundMessage(undefined, admission.parentSessionId, message, {
			sessionFile: stableCtx.sessionFile,
			expectedRunId: admission.runId,
		});
	} catch (deliveryError) {
		queueQueuedBackgroundFailure(stableCtx, admission, message, deliveryError);
	}
}

function queueQueuedBackgroundFailure(
	stableCtx: StableParentContext,
	admission: Admission,
	message: ReturnType<typeof queuedFailureMessage>,
	error: unknown,
): void {
	if (getForegroundDeliveryBarrier(admission.parentSessionId).isSuppressed()) return;
	queuePendingDeliveryWithVerification(
		admission.runId,
		admission.parentSessionId,
		message,
		error,
		{ sessionFile: stableCtx.sessionFile, expectedRunId: admission.runId },
		deliveryAttempt(error),
	);
	startDeliveryRetry();
}

function deliveryAttempt(error: unknown): number {
	return isSessionRuntimeUnavailable(error) ? 0 : 1;
}

function queuedFailureMessage(params: any, runId: string, error: unknown) {
	return {
		customType: "subagent_result",
		content: `Queued subagent "${displayName(params)}" [${runId}] failed to launch: ${errorMessage(error)}`,
		display: true,
		details: { id: runId, name: displayName(params), agent: params.agent },
	};
}

function queueForegroundLaunch(deps: ToolExecuteDeps, params: any, admission: Admission): void {
	queuedSubagents.set(admission.runId, {
		id: admission.runId,
		name: displayName(params),
		agent: params.agent,
		admissionClass: "foreground",
		queuedAt: Date.now(),
		cancel: () => admission.ticket.lease.cancel(),
	});
	deps.updateWidget();
}

async function awaitAdmission(deps: ToolExecuteDeps, admission: Admission): Promise<ToolResult | undefined> {
	try {
		await admission.ticket.admitted;
		return undefined;
	} catch (error) {
		queuedSubagents.delete(admission.runId);
		deps.updateWidget();
		admission.foregroundBarrierLease?.release();
		return toolResult(errorMessage(error), "cancelled", true, { id: admission.runId, status: "cancelled" });
	}
}

async function runBackgroundLaunch(
	deps: ToolExecuteDeps,
	params: any,
	context: ResolvedLaunchContext,
	admission: Admission,
): Promise<ToolResult> {
	const running = await startBackgroundLaunch(deps, params, context, admission);
	return startedResult(deps, params, running);
}

function startBackgroundLaunch(
	deps: ToolExecuteDeps,
	params: any,
	context: ResolvedLaunchContext,
	admission: Admission,
): Promise<RunningSubagent> {
	return deps.startBackgroundSpawn({
		params,
		ctx: context.stableCtx,
		agentDefinition: context.agentDefinition,
		selectedSkills: context.selectedSkills,
		runtimePlan: admission.runtimePlan,
		runId: admission.runId,
		admissionLease: admission.ticket.lease,
		projectTrusted: context.stableCtx.projectTrusted,
	});
}

function startedResult(deps: ToolExecuteDeps, params: any, running: RunningSubagent): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: deps.appendLayoutWarning(
					`Sub-agent "${running.name}" [${running.id}] launched in the background; completion will arrive automatically.`,
					running.layoutWarning,
				),
			},
		],
		details: {
			id: running.id,
			name: running.name,
			task: params.task,
			agent: params.agent,
			sessionFile: running.sessionFile,
			launchScriptFile: running.launchScriptFile,
			model: running.runtimePlan?.model,
			thinking: running.runtimePlan?.thinking,
			runtimePlan: running.runtimePlan,
			status: "started",
			class: "background",
			...(running.layoutWarning ? { layoutWarning: running.layoutWarning } : {}),
		},
	};
}

async function runBlockingLaunch(
	deps: ToolExecuteDeps,
	call: CallContext,
	context: ResolvedLaunchContext,
	admission: Admission,
): Promise<ToolResult> {
	const running = await launchBlockingRun(deps, call.params, context, admission);
	const watcherAbort = createBlockingWatcherAbort(call.signal, running);
	const watcher = startBlockingWatcher(deps, running, watcherAbort, admission.foregroundBarrierLease);
	return settleBlockingLaunch(deps, running, watcher);
}

async function launchBlockingRun(
	deps: ToolExecuteDeps,
	params: any,
	context: ResolvedLaunchContext,
	admission: Admission,
): Promise<RunningSubagent> {
	try {
		const running = await deps.launchSubagent(params, context.stableCtx, {
			agentDefinition: context.agentDefinition,
			selectedSkills: context.selectedSkills,
			runtimePlan: admission.runtimePlan,
			runId: admission.runId,
			admissionClass: admission.admissionClass,
			admissionLease: admission.ticket.lease,
			projectTrusted: context.stableCtx.projectTrusted,
		});
		running.foregroundBarrierLease = admission.foregroundBarrierLease;
		running.suppressStatusSteer = true;
		return running;
	} catch (error) {
		deps.captureStickyLaunchFailure({
			id: admission.runId,
			name: displayName(params),
			agent: params.agent,
			admissionClass: admission.admissionClass,
			startTime: admission.ticket.lease.admittedAt ?? Date.now(),
			error,
		});
		admission.ticket.lease.release();
		admission.foregroundBarrierLease?.release();
		throw error;
	}
}

function createBlockingWatcherAbort(signal: any, running: RunningSubagent): AbortController {
	const watcherAbort = new AbortController();
	running.abortController = watcherAbort;
	signal?.addEventListener("abort", () => watcherAbort.abort(), { once: true });
	if (signal?.aborted) watcherAbort.abort();
	return watcherAbort;
}

function startBlockingWatcher(
	deps: ToolExecuteDeps,
	running: RunningSubagent,
	watcherAbort: AbortController,
	foregroundBarrierLease: Admission["foregroundBarrierLease"],
): Promise<SubagentResult> {
	try {
		const watcher = deps.watchSubagent(running, watcherAbort.signal, { releaseOwnership: false });
		deps.startWidgetRefresh();
		deps.startStatusRefresh();
		deps.commitRunningLaunch(running);
		return watcher;
	} catch (error) {
		watcherAbort.abort();
		const aborted = running.launchTransaction?.signal.aborted ?? false;
		running.launchTransaction?.rollback();
		if (running.launchTransaction) finishLaunchTransaction(running.id, running.launchTransaction);
		deps.failLaunch(running, error, aborted);
		foregroundBarrierLease?.release();
		deps.updateWidget();
		throw error;
	}
}

async function settleBlockingLaunch(
	deps: ToolExecuteDeps,
	running: RunningSubagent,
	watcher: Promise<SubagentResult>,
): Promise<ToolResult> {
	const result = await watcher;
	completeBlockingRun(deps, running, result);
	return blockingResult(deps, running, result);
}

function completeBlockingRun(deps: ToolExecuteDeps, running: RunningSubagent, result: SubagentResult): void {
	running.sessionLease?.transition("finalizing");
	running.lifecycle = markDelivery(
		running.lifecycle,
		deps.shouldDeliverSubagentCompletion(running) ? "delivered" : "suppressed",
	);
	deps.captureStickyTerminalRun(running, result);
	runningSubagents.delete(running.id);
	if (!running.errorPanePreserved) deps.releaseRunOwnership(running);
	setTimeout(() => running.foregroundBarrierLease?.release(), 0);
	deps.updateWidget();
}

function blockingResult(deps: ToolExecuteDeps, running: RunningSubagent, result: SubagentResult): ToolResult {
	const failed = isTerminalFailure(result);
	return {
		content: [{ type: "text", text: blockingResultText(deps, running, result) }],
		details: blockingResultDetails(running, result, failed),
		isError: failed,
	};
}

function blockingResultText(deps: ToolExecuteDeps, running: RunningSubagent, result: SubagentResult): string {
	const base = deps.resolveResultPresentation(result, running.name, running.id);
	const mismatch = running.runtimePlan?.runtimeMismatch;
	return deps.appendLayoutWarning(mismatch ? `${base}\n\nRuntime warning: ${mismatch}` : base, running.layoutWarning);
}

function blockingResultDetails(
	running: RunningSubagent,
	result: SubagentResult,
	failed: boolean,
): Record<string, unknown> {
	return {
		...result,
		id: running.id,
		status: blockingStatus(result, failed),
		blocking: true,
		agent: running.agent,
		...(running.layoutWarning ? { layoutWarning: running.layoutWarning } : {}),
	};
}

function isTerminalFailure(result: SubagentResult): boolean {
	if (result.watchAbandoned) return false;
	return result.error === "cancelled" || result.exitCode !== 0 || Boolean(result.errorMessage);
}

function blockingStatus(result: SubagentResult, failed: boolean): string {
	if (result.watchAbandoned) return "abandoned";
	if (failed) return "error";
	return "completed";
}

function displayName(params: any): string {
	return params.label?.trim() || params.agent;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function failureResult(error: unknown): ToolResult {
	return toolResult(errorMessage(error), errorMessage(error), true);
}

function toolResult(text: string, error: string, isError = false, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { error, ...details }, ...(isError ? { isError: true } : {}) };
}
