import { type LiveSpan, SpanStatusCode } from "mlflow-tracing";
import type { PiMlflowConfig } from "./config.ts";

/** Why tracing is disabled, surfaced verbatim by `/mlflow`. */
export type DisabledReason = string;

/**
 * Per-extension-instance tracing state: one instance per extension *factory
 * invocation*, and pi re-runs that factory for every session runtime — so
 * this object is rebuilt on every session switch (`/new`, `/resume`,
 * `/fork`, session import), extension `/reload`, and cwd change. Only the
 * *setup result* is process-global (`src/setup.ts`'s `Symbol.for` cache),
 * which is what the "resolve once" design decision (D8) and the "no retry"
 * silent-disable decision (D9) actually apply to: a rebuilt instance reuses
 * the resolved config/experiment instead of re-initializing the SDK.
 */
export interface TracingState {
	config: PiMlflowConfig;
	/** Set once tracing is confirmed usable (experiment resolved + SDK initialized). */
	enabled: boolean;
	/** Populated when `enabled` is false. */
	disabledReason?: DisabledReason;
	/** Numeric experiment ID resolved once at load, per D8. */
	experimentId?: string;

	/**
	 * Root `AGENT` span for the in-flight turn-cycle, if any. pi emits a
	 * low-level `agent_start`/`agent_end` pair per *attempt* — auto-retry and
	 * overflow-compaction recovery each trigger `agent.continue()`, which fires
	 * another `agent_start` while `agent_settled` has not yet fired. Per D1,
	 * one MLflow trace covers the whole turn-cycle (`agent_start` through
	 * `agent_settled`), so this root span is opened only on the *first*
	 * `agent_start` of a trace and is closed only at `agent_settled` —
	 * subsequent `agent_start` events within the same trace do not replace it.
	 */
	rootSpan?: LiveSpan;
	/** `CHAIN` span for the currently in-progress turn, if any. */
	turnSpan?: LiveSpan;
	/**
	 * Final outcome of the current trace. A terminal error/aborted turn or any
	 * force-closed child marks it ERROR. A later successful recovery turn resets
	 * it to OK, so overflow recovery reports the eventual cycle result.
	 */
	finalCycleStatus: SpanStatusCode;
	/**
	 * The most recently *ended* turn span, kept around only so an `overflow`
	 * `session_compact` (which always fires after that turn's `turn_end` has
	 * already run, per pi's `_checkCompaction` call site) can still be parented
	 * to the turn it actually overflowed, per D4. Cleared whenever a new turn
	 * starts. mlflow-tracing spans remain valid `parent:` targets after `end()`
	 * (parenting is derived from the OTel span context, not liveness), so this
	 * is safe to use as a parent even though the span has already ended.
	 */
	lastEndedTurnSpan?: LiveSpan;
	/** Tool spans keyed by `toolCallId`, per D3 — not a LIFO stack. */
	toolSpans: Map<string, LiveSpan>;
	/** Monotonic turn counter across the whole trace, spanning multiple attempts. */
	turnCounter: number;
	/** Monotonic attempt counter within the trace: 0 for the first `agent_start`, +1 per retry/continue. */
	attemptIndex: number;
	/**
	 * Set by an `overflow` compaction with `willRetry: true`, to the compaction
	 * span itself; consumed (and cleared) by the very next `turn_start`, which
	 * parents the retry's new turn span under the compaction span instead of
	 * under the root. Since the compaction span is itself a child of the
	 * interrupted turn (see `lastEndedTurnSpan` above), this keeps the retried
	 * turn/LLM call a *descendant* of the turn it overflowed — the closest
	 * approximation of "nested under that same turn" achievable without
	 * reopening an already-ended span (which mlflow-tracing does not support
	 * re-computing duration/rollup for). The retried LLM span is additionally
	 * tagged `pi.attempt.reason: "post_compaction"` for direct identification.
	 */
	pendingRetryParent?: LiveSpan;
	/**
	 * Set by an `overflow` compaction with `willRetry: true`; consumed (and
	 * cleared) by the very next LLM span, tagging it `pi.attempt.reason:
	 * "post_compaction"` per D4, since that LLM span is the retried call.
	 */
	pendingAttemptReason?: string;
	/**
	 * Final HTTP status of the most recently completed provider call, if `pi`
	 * fired `after_provider_response` for it. Reset once attached to the next
	 * LLM span. This is NOT a retry history: pi's provider layer
	 * (`retryProviderRequest` in `@earendil-works/pi-ai`) retries failed HTTP
	 * calls internally and only calls `onResponse`/emits
	 * `after_provider_response` once, after a request finally succeeds —
	 * failed attempts are caught inside that retry loop and never reach
	 * extensions. There is currently no extension-visible per-attempt retry
	 * signal (pi's internal `auto_retry_start`/`auto_retry_end` events are
	 * only emitted to its UI event stream, not to `pi.on()` handlers).
	 */
	lastHttpStatus?: number;
	/**
	 * The in-progress `LLM` span for the current provider call, opened at
	 * `before_provider_request` (so its duration covers the actual request +
	 * streamed-response window) and closed at the matching `message_end`.
	 * `pi.on("message_start")` fires slightly later than
	 * `before_provider_request` (after the LLM context is built), so the
	 * request payload is what's available first and is used for the span's
	 * `inputs` when `captureContent` is enabled.
	 */
	activeLlmSpan?: LiveSpan;

	/**
	 * In-flight git provenance lookup for the current root span, started at
	 * the first `agent_start` and awaited before the root is ended/exported.
	 * Each underlying git command has its own bounded timeout, so provenance
	 * cannot stall settlement indefinitely.
	 */
	pendingGitProvenance?: Promise<void>;
	/** Resolved fresh at the start of each trace (first `agent_start`); used for `mlflow.trace.session` / git provenance metadata. */
	gitCommit?: string;
	gitBranch?: string;
	gitRepoUrl?: string;

	/**
	 * Expanded user prompt for the current turn-cycle, stashed from
	 * `before_agent_start` when `captureContent` is true. Published as root
	 * span inputs at settle/shutdown; cleared only in cycle reset after the
	 * root ends — never on re-entrant `agent_start`.
	 */
	pendingUserPrompt?: string;
	/**
	 * Last non-empty assistant plain-text extraction observed on `message_end`
	 * in the current cycle (capture on). Later empty/tool-only assistants do
	 * not wipe this. Cleared only in cycle reset after the root ends.
	 */
	lastAssistantText?: string;
	/**
	 * Assistant error/abort summary for the current cycle when no prose text
	 * is available: structural `errorMessage` or else the `stopReason` string.
	 * Cleared only in cycle reset after the root ends.
	 */
	lastAssistantError?: string;

	/**
	 * Normalized (never-rejecting) promise for a flush attempt that outlived
	 * its `SERVER_WAIT_GRACE_MS` wait, retained so the *next* flush attempt
	 * re-awaits that abandoned work instead of forgetting it. It is the
	 * aggregate of the retained-previous + current flush of the attempt that
	 * set it, so consecutive degraded cycles nest one layer deeper until an
	 * attempt completes within the bound and clears it.
	 *
	 * Per extension-instance state. Unlike the span/summary fields above it
	 * survives root-cycle reset, and lives until the retained work completes
	 * or a later attempt supersedes it — but a session switch, `/reload`, or
	 * cwd change rebuilds `TracingState` and discards it. The abandoned SDK
	 * export keeps running in the background either way (accepted no-WAL loss
	 * window).
	 *
	 * Wait-only: no lifecycle, span-status, retry, or setup/silent-disable
	 * decision may read it.
	 */
	pendingFlush?: Promise<void>;
	/**
	 * True when the most recent flush attempt exceeded `SERVER_WAIT_GRACE_MS`
	 * and the extension stopped waiting on it (the export continues in the
	 * background). Reset by the next attempt that completes within the bound.
	 * A boolean rather than a timestamp because nothing renders *when*
	 * degradation happened — `/mlflow` only needs to know that the latest
	 * attempt exceeded it. Rendered only while tracing is active, and never
	 * read by any lifecycle/setup decision.
	 */
	flushWaitExceeded: boolean;
}

export function createInitialState(config: PiMlflowConfig): TracingState {
	return {
		config,
		enabled: false,
		toolSpans: new Map(),
		turnCounter: 0,
		attemptIndex: 0,
		finalCycleStatus: SpanStatusCode.OK,
		flushWaitExceeded: false,
	};
}
