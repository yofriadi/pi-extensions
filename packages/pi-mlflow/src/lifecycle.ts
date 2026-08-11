import type {
	AgentSettledEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { context as otelContext, trace as otelTrace, ROOT_CONTEXT } from "@opentelemetry/api";
import type { LiveSpan } from "mlflow-tracing";
import * as mlflow from "mlflow-tracing";
import { resolveGitProvenance } from "./git.ts";
import { COST_ATTRIBUTE_KEY, gateContent, TOKEN_USAGE_ATTRIBUTE_KEY, TRACE_METADATA_KEYS } from "./metadata.ts";
import type { TracingState } from "./state.ts";

/**
 * Registers the pi lifecycle event handlers that drive the MLflow span tree.
 * All handlers are no-ops when `state.enabled` is false, so the extension has
 * zero runtime effect once tracing has been silently disabled (D9).
 *
 * Every handler body is wrapped so that an unexpected error while talking to
 * the tracing SDK degrades gracefully (drops that span/update, logs once)
 * rather than propagating into pi's event loop and affecting the actual
 * coding-agent session — this is a best-effort observability add-on, not a
 * component pi's core behavior should ever depend on or be disrupted by.
 */
export function registerLifecycleHandlers(pi: ExtensionAPI, state: TracingState): void {
	// Stash the expanded user prompt for the root chat-summary (capture-gated).
	// Does not open or end the root span — that remains agent_start / settle.
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
		if (!state.enabled) return;
		safely(() => onBeforeAgentStart(state, event));
	});

	pi.on("agent_start", async (_event: AgentStartEvent, ctx: ExtensionContext) => {
		if (!state.enabled) return;
		await safelyAsync(() => onAgentStart(pi, state, ctx));
	});

	pi.on("agent_settled", async (_event: AgentSettledEvent, _ctx: ExtensionContext) => {
		if (!state.enabled) return;
		await safelyAsync(() => onAgentSettled(state));
	});

	pi.on("turn_start", async (event: TurnStartEvent, _ctx: ExtensionContext) => {
		if (!state.enabled || !state.rootSpan) return;
		safely(() => onTurnStart(state, event));
	});

	pi.on("turn_end", async (event: TurnEndEvent, _ctx: ExtensionContext) => {
		if (!state.enabled || !state.turnSpan) return;
		safely(() => onTurnEnd(state, event));
	});

	// Opens the LLM span: this fires once pi has assembled the outgoing
	// provider payload, which is a much closer approximation of the actual
	// request start than `message_end` (fired only once the full response has
	// streamed in) would be as a span-open point.
	pi.on("before_provider_request", async (event: { payload: unknown }, ctx: ExtensionContext) => {
		if (!state.enabled || !state.turnSpan) return;
		safely(() => {
			// Defensive: close any still-open LLM span before opening a new one.
			// Under normal pi event ordering this should already be gone —
			// `message_end` closes it, and `turn_end` force-closes any remainder —
			// because provider-level HTTP retries (`retryProviderRequest` in pi-ai)
			// are fully internal and do not re-fire `before_provider_request` per
			// attempt. A second `before_provider_request` within one turn only
			// happens if a higher-level retry path somehow re-enters without an
			// intervening `turn_end` (not observed in current pi, but cheap to
			// guard against so a dangling span is never silently reused for a new
			// request's response).
			forceCloseDanglingLlmSpan(state);
			onBeforeProviderRequest(state, event, ctx);
		});
	});

	// `AfterProviderResponseEvent` is exported from pi's extensions submodule
	// (`@earendil-works/pi-coding-agent/dist/core/extensions`) but is not
	// re-exported from the package's top-level entry, so this handler is typed
	// structurally. Pi emits it only for the provider attempt that ultimately
	// succeeds; per-attempt retry status is not visible to extensions.
	pi.on("after_provider_response", async (event: { status: number }, _ctx: ExtensionContext) => {
		if (!state.enabled) return;
		state.lastHttpStatus = event.status;
	});

	pi.on("message_end", async (event: MessageEndEvent, _ctx: ExtensionContext) => {
		if (!state.enabled || !state.turnSpan) return;
		safely(() => onMessageEnd(state, event));
	});

	pi.on("tool_execution_start", async (event: ToolExecutionStartEvent, _ctx: ExtensionContext) => {
		if (!state.enabled || !state.turnSpan) return;
		safely(() => onToolExecutionStart(state, event));
	});

	pi.on("tool_execution_end", async (event: ToolExecutionEndEvent, _ctx: ExtensionContext) => {
		if (!state.enabled) return;
		safely(() => onToolExecutionEnd(state, event));
	});

	pi.on("session_compact", async (event: SessionCompactEvent, _ctx: ExtensionContext) => {
		if (!state.enabled) return;
		safely(() => onSessionCompact(state, event));
	});

	pi.on("session_shutdown", async (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
		if (!state.enabled) return;
		await safelyAsync(() => onSessionShutdown(state));
	});
}

function safely(fn: () => void): void {
	try {
		fn();
	} catch (error) {
		console.warn("pi-mlflow: dropped a tracing update due to an internal error", error);
	}
}

async function safelyAsync(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (error) {
		console.warn("pi-mlflow: dropped a tracing update due to an internal error", error);
	}
}

/**
 * `agent_start` fires once per low-level attempt, not once per turn-cycle:
 * automatic retry and overflow-compaction recovery each call
 * `agent.continue()`, which fires another `agent_start` before
 * `agent_settled`. Per D1, one MLflow trace must span the whole turn-cycle,
 * so a root span already open (from an earlier `agent_start` in the same
 * trace) is left alone here — only the very first `agent_start` of a trace
 * opens the root. `attemptIndex` still increments on every call so later
 * spans can be tagged with which attempt they belong to.
 *
 * Re-entrant `agent_start` must not clear pending chat-summary fields
 * (`pendingUserPrompt` / `lastAssistantText` / `lastAssistantError`).
 *
 * Git provenance is resolved in the background after the root span opens so
 * hung/slow `git` subprocesses never sit on the agent-loop critical path
 * (design goal: no noticeable latency). `agent_settled` still awaits that
 * already-started lookup before ending/exporting the root, so ordinary slow
 * repositories keep branch/commit metadata; each underlying git command has
 * its own timeout and cannot stall settlement indefinitely.
 *
 * After the root ends, settle awaits the real `mlflow.flushTraces()`
 * completion so a crash immediately after settlement cannot lose a finished
 * cycle. Failures are still accepted (no WAL durability).
 */
async function onAgentStart(pi: ExtensionAPI, state: TracingState, ctx: ExtensionContext): Promise<void> {
	// Re-entrant agent_start (retry/continue within the same turn-cycle): keep
	// the open root and pending chat-summary fields; only bump attemptIndex.
	if (state.rootSpan) {
		state.attemptIndex += 1;
		return;
	}

	const rootSpan = startRootSpan();
	state.rootSpan = rootSpan;
	state.toolSpans.clear();
	state.lastHttpStatus = undefined;
	state.turnCounter = 0;
	state.attemptIndex = 0;
	state.finalCycleStatus = mlflow.SpanStatusCode.OK;
	state.pendingAttemptReason = undefined;
	state.pendingRetryParent = undefined;
	state.lastEndedTurnSpan = undefined;
	state.gitCommit = undefined;
	state.gitBranch = undefined;
	state.gitRepoUrl = undefined;
	// Do not clear pendingUserPrompt / lastAssistantText / lastAssistantError
	// here: before_agent_start may already have stashed this cycle's prompt,
	// and re-entrant agent_start must keep mid-cycle summary fields. Clear
	// ownership is settle/shutdown cycle reset only (after root end).

	// Session id is available synchronously — attach it immediately so the
	// trace is grouped even if git provenance is still resolving.
	const sessionId = ctx.sessionManager.getSessionId();
	try {
		withActiveSpanContext(rootSpan, () => {
			mlflow.updateCurrentTrace({
				metadata: { [TRACE_METADATA_KEYS.SESSION]: sessionId },
			});
		});
	} catch (error) {
		console.warn("pi-mlflow: could not attach session metadata", error);
	}

	// Start git lookup off the critical path. Settlement awaits this promise
	// before ending the root so branch/commit still attach for ordinary slow
	// repos; git's own per-command timeouts keep the wait bounded.
	state.pendingGitProvenance = attachGitProvenance(pi, state, ctx, rootSpan);
}

/**
 * Resolve git provenance off the critical path and merge it into the open
 * root span's trace metadata. No-ops if the root was already replaced/closed
 * (e.g. a very fast turn-cycle, or shutdown) before git finished.
 */
async function attachGitProvenance(
	pi: ExtensionAPI,
	state: TracingState,
	ctx: ExtensionContext,
	rootSpan: LiveSpan,
): Promise<void> {
	try {
		const provenance = await resolveGitProvenance(pi, ctx.cwd);
		// Drop the result if this root is no longer current — a later
		// agent_start (new turn-cycle) or agent_settled/shutdown cleared it.
		if (state.rootSpan !== rootSpan) {
			return;
		}

		state.gitCommit = provenance?.commit;
		state.gitBranch = provenance?.branch;
		state.gitRepoUrl = provenance?.repoUrl;

		const metadata: Record<string, string> = {};
		if (state.gitCommit) {
			metadata[TRACE_METADATA_KEYS.GIT_COMMIT] = state.gitCommit;
		}
		if (state.gitRepoUrl) {
			metadata[TRACE_METADATA_KEYS.GIT_REPO_URL] = state.gitRepoUrl;
		}
		if (state.gitBranch) {
			metadata[TRACE_METADATA_KEYS.GIT_BRANCH] = state.gitBranch;
		}
		if (Object.keys(metadata).length === 0) {
			return;
		}

		withActiveSpanContext(rootSpan, () => {
			mlflow.updateCurrentTrace({ metadata });
		});
	} catch (error) {
		console.warn("pi-mlflow: could not attach git provenance", error);
	}
}

async function onAgentSettled(state: TracingState): Promise<void> {
	// Await the in-flight lookup (if any) before ending the root so git
	// metadata is present for traces created inside a repository. Each git
	// command already has a hard timeout, so this cannot hang indefinitely.
	if (state.pendingGitProvenance) {
		try {
			await state.pendingGitProvenance;
		} catch {
			// attachGitProvenance already swallows/logs; defensive only.
		}
		state.pendingGitProvenance = undefined;
	}

	await endRootCycle(state);
}

/**
 * Close the root cycle: force-close children, end the turn and root spans,
 * publish the capture-gated chat summary, reset cycle state, and flush.
 * Shared by the settle and shutdown paths so both end a cycle identically.
 */
async function endRootCycle(state: TracingState): Promise<void> {
	// Close children before the parent: ending the root pops+exports the trace
	// synchronously in the SDK, so any still-open turn/tool spans must be
	// force-closed first to remain attached to (and observed within) that trace.
	// Force-closed children also mark the cycle ERROR unless a later successful
	// recovery turn already restored the outcome.
	forceCloseToolSpans(state);
	forceCloseDanglingLlmSpan(state);
	if (state.turnSpan) {
		endSpan(state.turnSpan, { status: mlflow.SpanStatusCode.ERROR, attributes: { "pi.span.incomplete": true } });
		state.turnSpan = undefined;
		state.finalCycleStatus = mlflow.SpanStatusCode.ERROR;
	}
	// Publish capture-gated root chat summary while the root LiveSpan is still
	// open — ending the root pops+exports the trace in the SDK.
	publishRootTurnSummary(state);
	if (state.rootSpan) {
		endSpan(state.rootSpan, { status: state.finalCycleStatus });
		state.rootSpan = undefined;
	}
	// Drop git + chat-summary state with the closed root so a subsequent
	// turn-cycle starts clean (single clear owner: post-root-end reset).
	state.gitCommit = undefined;
	state.gitBranch = undefined;
	state.gitRepoUrl = undefined;
	state.lastEndedTurnSpan = undefined;
	state.lastHttpStatus = undefined;
	state.pendingAttemptReason = undefined;
	state.pendingRetryParent = undefined;
	state.pendingUserPrompt = undefined;
	state.lastAssistantText = undefined;
	state.lastAssistantError = undefined;
	state.finalCycleStatus = mlflow.SpanStatusCode.OK;

	// Await real flush completion so the finished cycle is exported before
	// settle/shutdown returns. A crash after settlement must not lose the
	// completed cycle; export failures remain accepted (no WAL).
	await flushTracesBestEffort();
}

function onTurnStart(state: TracingState, _event: TurnStartEvent): void {
	if (!state.rootSpan) return;
	state.lastHttpStatus = undefined;
	// A post-compaction retry is parented under its compaction span, which is
	// itself a child of the interrupted turn. Otherwise use the root.
	const parent = state.pendingRetryParent ?? state.rootSpan;
	state.pendingRetryParent = undefined;
	// A new turn supersedes the previous ended-turn pointer; this prevents a
	// malformed later overflow event from reusing a turn from two turns ago.
	state.lastEndedTurnSpan = undefined;
	state.turnSpan = mlflow.startSpan({
		name: "pi.turn",
		spanType: mlflow.SpanType.CHAIN,
		parent,
		attributes: {
			"pi.turn.index": state.turnCounter,
			"pi.attempt.index": state.attemptIndex,
		},
	});
}

function onTurnEnd(state: TracingState, event: TurnEndEvent): void {
	if (!state.turnSpan) return;
	forceCloseToolSpans(state);
	forceCloseDanglingLlmSpan(state);
	const failed =
		event.message.role === "assistant" &&
		(event.message.stopReason === "error" || event.message.stopReason === "aborted");
	const endedTurn = state.turnSpan;
	endSpan(endedTurn, {
		status: failed ? mlflow.SpanStatusCode.ERROR : mlflow.SpanStatusCode.OK,
		// toolResultCount is structural (a count, not tool output bodies) and
		// must remain always-on regardless of captureContent (D6 / trace-metadata).
		attributes: { "pi.turn.toolResultCount": event.toolResults.length },
	});
	// Terminal turn outcome drives the root: error/aborted leaves the cycle
	// ERROR, while a later successful recovery attempt restores OK.
	state.finalCycleStatus = failed ? mlflow.SpanStatusCode.ERROR : mlflow.SpanStatusCode.OK;
	// Keep this only until a following overflow compaction can consume it;
	// onTurnStart clears it for all ordinary subsequent turns.
	state.lastEndedTurnSpan = endedTurn;
	state.turnSpan = undefined;
	state.turnCounter += 1;
}

/**
 * Opens the `LLM` span for the upcoming provider call. `event.payload` is
 * whatever pi's model runtime is about to send to the provider; it's the
 * closest thing to "the request" extensions get, so it's used as this span's
 * `inputs` (gated by `captureContent`, since it may contain the full prompt
 * and conversation history).
 */
function onBeforeProviderRequest(state: TracingState, event: { payload: unknown }, ctx: ExtensionContext): void {
	if (!state.turnSpan) return;
	state.activeLlmSpan = mlflow.startSpan({
		name: "pi.llm",
		spanType: mlflow.SpanType.LLM,
		parent: state.turnSpan,
		attributes: {
			"pi.turn.index": state.turnCounter,
			"pi.attempt.index": state.attemptIndex,
			...(ctx.thinkingLevel ? { "pi.llm.thinkingLevel": ctx.thinkingLevel } : {}),
		},
		inputs: gateContent(state.config.captureContent, event.payload),
	});
}

/**
 * Closes the LLM span opened at `before_provider_request` with the finished
 * assistant message's usage/cost/content. Also handles the case where no
 * `before_provider_request` fired for this message (older pi builds, or an
 * extension environment without that hook) by opening-and-immediately-ending
 * a span here instead, so tracing degrades gracefully rather than silently
 * losing the LLM span entirely.
 */
function onMessageEnd(state: TracingState, event: MessageEndEvent): void {
	const message = event.message;
	if (message.role !== "assistant" || !state.turnSpan) return;

	// Capture-gated root chat-summary bookkeeping (independent of LLM span close).
	if (state.config.captureContent) {
		const text = extractAssistantText(message.content);
		if (text) {
			state.lastAssistantText = text;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			state.lastAssistantError = extractAssistantErrorMessage(message) ?? message.stopReason;
		}
	}

	const usage = message.usage;
	const attributes: Record<string, unknown> = {
		"pi.llm.provider": message.provider,
		"pi.llm.model": message.model,
	};

	if (state.pendingAttemptReason) {
		attributes["pi.attempt.reason"] = state.pendingAttemptReason;
		state.pendingAttemptReason = undefined;
	}

	if (usage) {
		attributes[TOKEN_USAGE_ATTRIBUTE_KEY] = {
			input_tokens: usage.input,
			output_tokens: usage.output,
			total_tokens: usage.totalTokens,
		};

		if (usage.cost) {
			attributes[COST_ATTRIBUTE_KEY] = {
				input_cost: usage.cost.input,
				output_cost: usage.cost.output,
				total_cost: usage.cost.total,
			};
		}
	}

	// Final HTTP status of the provider call, if pi's `after_provider_response`
	// fired for it — see the long comment at that handler's registration for
	// why this cannot be a retry history/count (pi's extension API doesn't
	// expose per-attempt status; only the eventually-successful call's status
	// is observable). Status code only, never a response body.
	if (state.lastHttpStatus !== undefined) {
		attributes["pi.llm.httpStatusCode"] = state.lastHttpStatus;
		state.lastHttpStatus = undefined;
	}

	const llmSpan =
		state.activeLlmSpan ??
		mlflow.startSpan({
			name: "pi.llm",
			spanType: mlflow.SpanType.LLM,
			parent: state.turnSpan,
			attributes: { "pi.turn.index": state.turnCounter, "pi.attempt.index": state.attemptIndex },
		});
	state.activeLlmSpan = undefined;
	llmSpan.setAttributes(attributes);

	endSpan(llmSpan, {
		status:
			message.stopReason === "error" || message.stopReason === "aborted"
				? mlflow.SpanStatusCode.ERROR
				: mlflow.SpanStatusCode.OK,
		outputs: gateContent(state.config.captureContent, message.content),
	});
}

function onToolExecutionStart(state: TracingState, event: ToolExecutionStartEvent): void {
	if (!state.turnSpan) return;
	const span = mlflow.startSpan({
		name: event.toolName,
		spanType: mlflow.SpanType.TOOL,
		parent: state.turnSpan,
		inputs: gateContent(state.config.captureContent, event.args),
	});
	state.toolSpans.set(event.toolCallId, span);
}

function onToolExecutionEnd(state: TracingState, event: ToolExecutionEndEvent): void {
	const span = state.toolSpans.get(event.toolCallId);
	if (!span) return;
	state.toolSpans.delete(event.toolCallId);
	endSpan(span, {
		status: event.isError ? mlflow.SpanStatusCode.ERROR : mlflow.SpanStatusCode.OK,
		outputs: gateContent(state.config.captureContent, event.result),
	});
}

/**
 * Force-close any tool spans still open in the map. Used at `turn_end` (D3
 * mitigation for tool spans that outlive their turn) and at `agent_settled`
 * / `session_shutdown` (orphan sweep, D2/D3).
 */
function forceCloseToolSpans(state: TracingState): void {
	for (const [toolCallId, span] of state.toolSpans) {
		endSpan(span, { status: mlflow.SpanStatusCode.ERROR, attributes: { "pi.span.incomplete": true } });
		state.toolSpans.delete(toolCallId);
		state.finalCycleStatus = mlflow.SpanStatusCode.ERROR;
	}
}

/**
 * Force-close a dangling `activeLlmSpan` — e.g. the turn/agent ended before
 * the matching `message_end` fired (error, abort, or an unexpected event
 * ordering), or a second `before_provider_request` arrived while one was still
 * open. Mirrors `forceCloseToolSpans`'s incomplete-status convention.
 *
 * Also clears request-scoped fields (`lastHttpStatus`, `pendingAttemptReason`)
 * that would otherwise be attributed to the *next* LLM span if the dangling
 * request never reached `message_end` to consume them.
 */
function forceCloseDanglingLlmSpan(state: TracingState): void {
	if (!state.activeLlmSpan) return;
	endSpan(state.activeLlmSpan, { status: mlflow.SpanStatusCode.ERROR, attributes: { "pi.span.incomplete": true } });
	state.activeLlmSpan = undefined;
	// Drop per-request metadata that belonged to the incomplete span so a
	// subsequent request in the same turn cannot inherit it.
	state.lastHttpStatus = undefined;
	state.pendingAttemptReason = undefined;
	state.finalCycleStatus = mlflow.SpanStatusCode.ERROR;
}

function onSessionCompact(state: TracingState, event: SessionCompactEvent): void {
	const { reason, compactionEntry, willRetry } = event;

	const parent: LiveSpan | undefined =
		reason === "overflow" ? (state.lastEndedTurnSpan ?? state.turnSpan ?? state.rootSpan) : state.rootSpan;

	if (!parent) {
		// No active trace (idle between prompts) — matches pi-langfuse's existing
		// precedent of not tracing compaction that happens outside an active trace.
		return;
	}

	const span = mlflow.startSpan({
		name: "pi.compaction",
		spanType: mlflow.SpanType.CHAIN,
		parent,
		attributes: {
			"pi.compaction.reason": reason,
			"pi.compaction.willRetry": willRetry,
			"pi.compaction.tokensBefore": compactionEntry.tokensBefore,
			"pi.compaction.firstKeptEntryId": compactionEntry.firstKeptEntryId,
		},
	});
	endSpan(span, { status: mlflow.SpanStatusCode.OK });

	// Overflow compaction with willRetry=true means pi is about to call
	// agent.continue() for a retried LLM call within the same turn-cycle:
	// tag that upcoming LLM span as a post-compaction retry, and parent its
	// new turn span under this compaction span (not the root) so it remains a
	// descendant of the turn it overflowed.
	if (reason === "overflow" && willRetry) {
		state.pendingAttemptReason = "post_compaction";
		state.pendingRetryParent = span;
	}
}

async function onSessionShutdown(state: TracingState): Promise<void> {
	// Abandon in-flight git work; the root is about to be force-closed anyway.
	state.pendingGitProvenance = undefined;
	await endRootCycle(state);
}

/**
 * Await the SDK exporter so a finished cycle is durable before settle/shutdown
 * returns. Export failures are swallowed — best-effort observability with no
 * WAL, per design.
 */
async function flushTracesBestEffort(): Promise<void> {
	try {
		await mlflow.flushTraces();
	} catch {
		// Best-effort flush; a failed flush means that batch may be lost,
		// consistent with the accepted durability trade-off (no WAL).
	}
}

/** Thin wrapper so every span-ending call site has one place to harden against SDK errors. */
function endSpan(span: LiveSpan, options: Parameters<LiveSpan["end"]>[0]): void {
	span.end(options);
}

/**
 * Run `fn` with the OTel context active-span temporarily set to `span`'s
 * underlying OTel span, so SDK calls that read the active span from context
 * (like `updateCurrentTrace`) resolve to the same trace/span `startSpan`
 * created.
 *
 * NOTE: reaches into LiveSpan's private `_span` field — fragile across
 * `mlflow-tracing` upgrades. Prefer a supported public API if one appears.
 */
function withActiveSpanContext(span: LiveSpan, fn: () => void): void {
	const otelSpan = (span as unknown as { _span: Parameters<typeof otelTrace.setSpan>[1] })._span;
	const ctx = otelTrace.setSpan(otelContext.active(), otelSpan);
	otelContext.with(ctx, fn);
}

/** Start a root span from ROOT_CONTEXT so an unrelated active OTel span cannot become its parent. */
function startRootSpan(): LiveSpan {
	let rootSpan: LiveSpan | undefined;
	otelContext.with(ROOT_CONTEXT, () => {
		rootSpan = mlflow.startSpan({
			name: "pi.agent",
			spanType: mlflow.SpanType.AGENT,
		});
	});
	if (!rootSpan) {
		throw new Error("pi-mlflow: MLflow SDK did not create a root span");
	}
	return rootSpan;
}

function onBeforeAgentStart(state: TracingState, event: BeforeAgentStartEvent): void {
	if (!state.config.captureContent) return;
	state.pendingUserPrompt = event.prompt;
}

/**
 * Join plain text from assistant message content for the root chat summary.
 * Accepts string content or content-part arrays; keeps only `type === "text"`
 * parts (and bare strings). Skips thinking / toolCall / other part types.
 * Local helper — no `@earendil-works/pi-ai` dependency for `contentText`.
 */
export function extractAssistantText(content: unknown): string | undefined {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (!Array.isArray(content)) return undefined;

	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			if (part.length > 0) parts.push(part);
			continue;
		}
		if (
			part &&
			typeof part === "object" &&
			"type" in part &&
			(part as { type?: unknown }).type === "text" &&
			"text" in part &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			const text = (part as { text: string }).text;
			if (text.length > 0) parts.push(text);
		}
	}
	const joined = parts.join("").trim();
	return joined.length > 0 ? joined : undefined;
}

/**
 * Structural read of optional `errorMessage` on an assistant message without
 * depending on a fully installed pi-ai graph for every field.
 */
function extractAssistantErrorMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	if (!("errorMessage" in message)) return undefined;
	const value = (message as { errorMessage?: unknown }).errorMessage;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Write capture-gated root turn summary (string inputs/outputs) while the
 * root LiveSpan is still open. Does **not** clear pending chat fields — that
 * remains the settle/shutdown cycle-reset owner's job.
 */
export function publishRootTurnSummary(state: TracingState): void {
	if (!state.config.captureContent || !state.rootSpan) return;
	state.rootSpan.setInputs(state.pendingUserPrompt ?? "");
	state.rootSpan.setOutputs(state.lastAssistantText ?? state.lastAssistantError ?? "");
}
