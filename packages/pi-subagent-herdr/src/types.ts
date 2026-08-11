import type { SubagentActivityState } from "./activity.ts";
import type { AdmissionLease } from "./coordinator.ts";
import type { ForegroundBarrierLease } from "./delivery-barrier.ts";
import type { LaunchTransaction } from "./launch-transaction.ts";
import type { LifecycleProjection, PaneInspection, SubagentLifecycle } from "./lifecycle.ts";
import type { ResolvedRuntimePlan } from "./runtime-routing.ts";
import type { SessionLease } from "./session-leases.ts";
import type { SubagentStatusState } from "./status.ts";

/** Result from running a single subagent. */
export interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	sessionFile?: string;
	exitCode: number;
	elapsed: number;
	error?: string;
	/** Provider/agent error message when auto-retry exhausted. */
	errorMessage?: string;
	alreadySettled?: boolean;
	/** Watching stopped without completion evidence; outcome remains unknown. */
	watchAbandoned?: boolean;
}

/** State for a launched but not yet completed subagent. */
export interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	agent?: string;
	parentSessionId?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	launchScriptFile?: string;
	activityFile?: string;
	activity?: SubagentActivityState;
	activityRead?: { ok: boolean; reason?: "missing" | "invalid" | "wrong-id"; error?: string };
	abortController?: AbortController;
	statusState?: SubagentStatusState;
	lifecycle: SubagentLifecycle;
	lastProjectedKind?: LifecycleProjection["kind"];
	suppressStatusSteer?: boolean;
	layoutWarning?: string;
	runtimePlan: ResolvedRuntimePlan | undefined;
	admissionClass?: "foreground" | "background";
	admissionLease?: AdmissionLease;
	sessionLease?: SessionLease;
	entryCountBefore?: number;
	foregroundBarrierLease?: ForegroundBarrierLease;
	launchTransaction?: LaunchTransaction;
	parentSessionFile?: string;
	errorPanePreserved?: boolean;
	errorPaneMonitorStarted?: boolean;
	deliveryWait?: { kind: DeliveryWaitKind; since: number };
	completionTimeoutMs?: number;
	watchAbandoned?: boolean;
	inspectPaneOverride?: () => Promise<PaneInspection>;
}

export interface QueuedSubagent {
	id: string;
	name: string;
	agent: string;
	admissionClass: "foreground" | "background";
	queuedAt: number;
	cancel: () => boolean;
}

export type StickyTerminalKind = "failed" | "stopped" | "watch-abandoned";

export interface StickyTerminalRun {
	id: string;
	name: string;
	agent?: string;
	admissionClass?: "foreground" | "background";
	startTime: number;
	runtimeEndedAt: number;
	sessionFile?: string;
	activity?: SubagentActivityState;
	kind: StickyTerminalKind;
	capturedAt: number;
}

/** Plain, reload-safe inputs captured before a queued launch is admitted. */
export interface StableParentContext {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionDir: string;
}

export type DeliveryWaitKind = "barrier" | "turn-boundary" | "verifying";

export interface PendingDelivery {
	id: string;
	parentSessionId: string;
	message: any;
	attempts: number;
	nextRetryAt: number;
	lastError?: string;
	delivering: boolean;
	exhausted?: boolean;
	exhaustionCause?: "attempts" | "deferral";
	generation: number;
	sessionFile?: string;
	expectedRunId?: string;
	deferredSince?: number;
}
