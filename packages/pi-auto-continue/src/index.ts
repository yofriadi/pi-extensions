import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { classifyInterruption } from "./classifier.ts";
import { loadConfig, parseDuration, parseMaxRetries, parseTargetTime } from "./config.ts";
import {
  DEFAULT_RATE_LIMIT_BASE_DELAY_MS,
  DEFAULT_RATE_LIMIT_MAX_DELAY_MS,
  DEFAULT_RATE_LIMIT_MAX_RETRIES,
  DEFAULT_RATE_LIMIT_RETRY_PROMPT,
  SUBAGENT_DONE_TOOL_NAMES,
  SUBAGENT_ENV_VARS,
} from "./constants.ts";
import {
  formatDateTime,
  formatDelay,
  formatDuration,
  formatMaxRetries,
  formatTime,
  truncateErrorMessage,
} from "./formatter.ts";
import { RetryManager, type RetryCheckResult } from "./retry-manager.ts";
import type { ClassificationResult } from "./types.ts";

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;
type RecoveryType = "RATE_LIMIT" | "TOKEN_LIMIT" | "INCOMPLETE_TOOL_CALL";
const SUBMISSION_TIMEOUT_MS = 30_000;
const BUSY_RECHECK_MS = 1000;

interface ObservedResponse {
  status: number;
  headers: Record<string, string>;
  time: number;
}

interface ObservedAssistant {
  message: AssistantMessage;
  response?: ObservedResponse;
}

interface PendingRecovery {
  timer?: ReturnType<typeof setTimeout>;
  generation: number;
  sessionId: string;
  provider?: string;
  modelId?: string;
  dueAt: number;
  type: RecoveryType;
  result: RetryCheckResult;
  ctx: ExtensionContext;
  manual: boolean;
}

interface DispatchedRecovery {
  prompt: string;
  wirePrompt: string;
  generation: number;
  phase: "submitted" | "accepted" | "started";
  timer?: ReturnType<typeof setTimeout>;
}

export default function (pi: ExtensionAPI, customSettingsPath?: string) {
  let config = loadConfig(customSettingsPath);
  const retryManager = new RetryManager();
  let generation = 0;
  const submissionPrefix = `<!-- auto-continue:${randomUUID()}:`;
  let submissionSequence = 0;
  let pending: PendingRecovery | undefined;
  let dispatched: DispatchedRecovery | undefined;
  let lastAssistant: ObservedAssistant | undefined;
  let lastHttpResponse: ObservedResponse | undefined;
  let lastExpectedTokenResetTime: number | undefined;
  let processedMessages = new WeakSet<AssistantMessage>();
  let detachAbort: (() => void) | undefined;
  let detachTerminalInput: (() => void) | undefined;
  let suppressRecovery = false;
  let compacting = false;
  let observingAssistant = false;
  let shuttingDown = false;

  const isSubagentSession = (): boolean =>
    SUBAGENT_ENV_VARS.some((name) => !!process.env[name]);

  const isAutoActive = (): boolean =>
    config.enabled && (!isSubagentSession() || config.subagent);

  const notify = (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "info"
  ) => {
    if (ctx.hasUI) {
      ctx.ui.notify(`[auto-continue] [${formatTime(Date.now())}] ${message}`, type);
    }
  };

  const cancelWait = () => {
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    pending = undefined;
  };

  const clearSubmission = () => {
    if (dispatched?.timer !== undefined) clearTimeout(dispatched.timer);
    dispatched = undefined;
  };

  const resetRecovery = (keepAbortListener = false) => {
    generation++;
    cancelWait();
    clearSubmission();
    if (!keepAbortListener) {
      detachAbort?.();
      detachAbort = undefined;
    }
    retryManager.reset();
    lastAssistant = undefined;
    lastHttpResponse = undefined;
    lastExpectedTokenResetTime = undefined;
    processedMessages = new WeakSet();
  };

  const stopRecovery = () => {
    resetRecovery();
    suppressRecovery = true;
  };

  const dispatchRecovery = (wait: PendingRecovery) => {
    if (pending !== wait || wait.generation !== generation) return;
    try {
      if (
        !config.enabled || shuttingDown || suppressRecovery ||
        (!wait.manual && !isAutoActive()) ||
        ctxChanged(wait)
      ) {
        stopRecovery();
        return;
      }

      const state = retryManager.getState();
      const limit = retryManager.getActiveLimit(config, wait.type);
      if (
        limit.type === "duration" && state.startTime !== null &&
        Date.now() - state.startTime >= limit.durationMs
      ) {
        notify(wait.ctx, `Retry deadline of ${formatDuration(limit.durationMs)} reached; no continuation sent.`, "error");
        stopRecovery();
        return;
      }

      // Manual schedules wait for Pi to become idle without entering its queues.
      // Poll as well as listening for settlement: standalone compaction does not
      // necessarily emit agent_settled when it finishes.
      if (compacting || !wait.ctx.isIdle() || wait.ctx.hasPendingMessages()) {
        if (wait.manual) armTimer(wait, BUSY_RECHECK_MS);
        else stopRecovery();
        return;
      }

      const prompt = wait.type === "RATE_LIMIT"
        ? config.rateLimit.retryPrompt || DEFAULT_RATE_LIMIT_RETRY_PROMPT
        : wait.type === "TOKEN_LIMIT"
          ? config.tokenLimit.continuePrompt
          : config.incompleteToolCall.continuePrompt;
      cancelWait();
      const submission: DispatchedRecovery = {
        prompt,
        wirePrompt: `${submissionPrefix}${++submissionSequence} -->\n${prompt}`,
        generation,
        phase: "submitted",
      };
      dispatched = submission;
      // sendUserMessage is fire-and-forget; Pi reports asynchronous failures to
      // its error listeners, not this try/catch. Never resend an unacknowledged
      // submission: it may still start after a slow preflight or another hook.
      submission.timer = setTimeout(() => {
        if (dispatched !== submission) return;
        stopRecovery();
        notify(wait.ctx, "Continuation did not start within 30s. Automatic recovery paused to avoid duplicate prompts; check Pi's status before resuming manually.", "warning");
      }, SUBMISSION_TIMEOUT_MS);
      notify(wait.ctx, `Retrying request (attempt #${wait.result.attempt})...`);
      pi.sendUserMessage(submission.wirePrompt, { deliverAs: "followUp" });
    } catch (error) {
      stopRecovery();
      notify(wait.ctx, `Failed to send continuation: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const ctxChanged = (wait: PendingRecovery): boolean =>
    wait.ctx.sessionManager.getSessionId() !== wait.sessionId ||
    wait.ctx.model?.provider !== wait.provider || wait.ctx.model?.id !== wait.modelId;

  // Node clamps overflowing timeouts to 1ms. Chunk long waits, and always
  // defer even zero-delay sends beyond the current lifecycle hook.
  const armTimer = (wait: PendingRecovery, minimumDelayMs = 0) => {
    if (wait.timer !== undefined) clearTimeout(wait.timer);
    wait.timer = setTimeout(() => {
      wait.timer = undefined;
      if (pending !== wait) return;
      if (Date.now() < wait.dueAt) armTimer(wait);
      else dispatchRecovery(wait);
    }, Math.min(Math.max(minimumDelayMs, wait.dueAt - Date.now()), 2_147_483_647));
  };

  const scheduleRecovery = (
    result: RetryCheckResult,
    type: RecoveryType,
    ctx: ExtensionContext,
    classification?: ClassificationResult,
    manual = false
  ) => {
    if (!result.canRetry) {
      notify(ctx, `${type === "RATE_LIMIT" ? "Rate limit retry" : "Continuation"} stopped: ${result.reason || "limit exceeded"} after ${result.attempt} attempt(s).`, result.deadlineExceeded ? "error" : "warning");
      retryManager.reset();
      return;
    }

    cancelWait();
    const wait: PendingRecovery = {
      generation,
      sessionId: ctx.sessionManager.getSessionId(),
      provider: ctx.model?.provider,
      modelId: ctx.model?.id,
      dueAt: Date.now() + result.delayMs,
      type,
      result,
      ctx,
      manual,
    };
    pending = wait;

    const limit = retryManager.getActiveLimit(config, type);
    const limitText = limit.type === "duration"
      ? `attempt #${result.attempt}, elapsed: ${formatDuration(result.elapsedMs)} / max: ${formatDuration(limit.durationMs)}`
      : `attempt #${result.attempt} of ${limit.count}, elapsed: ${formatDuration(result.elapsedMs)}`;
    const description = type === "RATE_LIMIT"
      ? "Transient provider / rate limit error"
      : type === "TOKEN_LIMIT" ? "Response truncated" : "Output cut off mid-tool-call";
    let notice = `${description}${classification?.errorMessage ? `: "${truncateErrorMessage(classification.errorMessage)}"` : ""}.\nWaiting ${formatDelay(result.delayMs)} before retry (${limitText})...`;
    const resetTime = retryManager.getState().expectedTokenResetTime;
    if (resetTime !== undefined) notice += `\nExpected token reset time: ${formatDateTime(resetTime)}`;
    notify(ctx, notice, type === "RATE_LIMIT" ? "warning" : "info");

    armTimer(wait);
  };

  pi.on("session_start", (_event, ctx) => {
    resetRecovery();
    observingAssistant = false;
    config = loadConfig(customSettingsPath);
    suppressRecovery = false;
    compacting = false;
    shuttingDown = false;
    detachTerminalInput?.();
    detachTerminalInput = undefined;
    // Pi 0.85.1 has no extension-visible SDK/RPC abort event during native
    // retry waits or our idle timer waits; ctx.signal only covers active turns.
    // TUI keys cover these waits. SDK/RPC callers must use off/reset before abort.
    if (ctx.mode === "tui") {
      detachTerminalInput = ctx.ui.onTerminalInput((data) => {
        // Do not consume the key: Pi must still cancel its own retry/stream.
        if (/^(?:\x1b|\x03|\x1b\[(?:27|99;5)(?::[123])?u)$/.test(data)) {
          const wasRecovering = pending !== undefined || retryManager.getState().isRetrying;
          stopRecovery();
          if (wasRecovering) notify(ctx, "Retry/continuation cancelled.");
        }
        return undefined;
      });
    }
  });

  pi.on("session_shutdown", () => {
    stopRecovery();
    shuttingDown = true;
    detachTerminalInput?.();
    detachTerminalInput = undefined;
  });
  pi.on("session_before_switch", stopRecovery);
  pi.on("session_before_fork", stopRecovery);
  pi.on("session_before_tree", stopRecovery);
  pi.on("session_tree", stopRecovery);
  pi.on("model_select", stopRecovery);

  pi.on("turn_start", (_event, ctx) => {
    lastHttpResponse = undefined;
    observingAssistant = true;
    detachAbort?.();
    detachAbort = undefined;
    const signal = ctx.signal;
    if (signal?.aborted) stopRecovery();
    else if (signal) {
      signal.addEventListener("abort", stopRecovery, { once: true });
      detachAbort = () => signal.removeEventListener("abort", stopRecovery);
    }
  });
  pi.on("turn_end", () => {
    observingAssistant = false;
    lastHttpResponse = undefined;
  });

  // A response belongs to one request/assistant message, not an arbitrary TTL.
  // Provider hooks also run for summaries outside the assistant turn.
  pi.on("before_provider_request", () => { lastHttpResponse = undefined; });
  pi.on("after_provider_response", (event) => {
    if (observingAssistant && !compacting) {
      lastHttpResponse = { status: event.status, headers: event.headers, time: Date.now() };
    }
  });

  pi.on("session_before_compact", (event) => {
    compacting = true;
    observingAssistant = false;
    lastHttpResponse = undefined;
    if (!pending?.manual) cancelWait();
    if (event.reason === "manual") stopRecovery();
    else if (event.willRetry) lastAssistant = undefined;
  });
  pi.on("session_compact", (event) => {
    compacting = false;
    lastHttpResponse = undefined;
    if (event.willRetry) lastAssistant = undefined;
    if (pending?.manual) armTimer(pending);
  });
  pi.on("session_compact_failed", () => {
    compacting = false;
    stopRecovery();
  });

  pi.on("tool_execution_end", (event) => {
    if (!event.isError && (SUBAGENT_DONE_TOOL_NAMES as readonly string[]).includes(event.toolName)) {
      shuttingDown = true;
      stopRecovery();
    }
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension" && event.text.startsWith(submissionPrefix)) {
      // Only a per-instance transport token identifies our input. Plain text
      // (including another extension's identical continuation) is never owned.
      if (dispatched?.phase !== "submitted" || event.text !== dispatched.wirePrompt ||
          dispatched.generation !== generation || !config.enabled || shuttingDown || suppressRecovery) {
        return { action: "handled" };
      }
      dispatched.phase = "accepted";
      return { action: "transform", text: dispatched.prompt };
    }

    const wasRecovering = pending !== undefined || retryManager.getState().isRetrying;
    if (event.source === "interactive" || event.source === "rpc") shuttingDown = false;
    stopRecovery();
    if (wasRecovering) notify(ctx, "New input received: cancelling active retry/continuation loop.");
    return { action: "continue" };
  });

  pi.on("before_agent_start", () => {
    if (dispatched?.phase === "accepted" && dispatched.generation === generation) {
      dispatched.phase = "started";
    } else {
      resetRecovery();
    }
    suppressRecovery = false;
  });

  pi.on("agent_start", () => {
    if (pending && !pending.manual) cancelWait();
    lastAssistant = undefined;
    lastHttpResponse = undefined;
    observingAssistant = false;
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "user") return;
    if (dispatched && dispatched.phase !== "submitted" && dispatched.generation === generation) {
      clearSubmission();
    } else {
      // Pi emits turn_start before the user message, including queued input.
      // Reset the retry budget without detaching this turn's abort listener.
      resetRecovery(true);
    }
    suppressRecovery = false;
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    // No sleeping, retry accounting, or prompt submission in this hook. Pi
    // still needs to finish tools, native retries, and compaction first.
    lastAssistant = { message: event.message, response: lastHttpResponse };
    lastHttpResponse = undefined;
    observingAssistant = false;
    if (event.message.stopReason === "aborted") stopRecovery();
  });

  pi.on("agent_settled", (_event, ctx) => {
    detachAbort?.();
    detachAbort = undefined;
    if (pending?.manual) {
      if (Date.now() >= pending.dueAt) dispatchRecovery(pending);
      return;
    }
    if (!isAutoActive() || shuttingDown || suppressRecovery || compacting || pending || dispatched) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const observed = lastAssistant;
    if (!observed || processedMessages.has(observed.message)) return;
    processedMessages.add(observed.message);

    const message = observed.message;
    const response = message.stopReason === "error" ? observed.response : undefined;
    const classification = classifyInterruption({
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      content: message.content,
      httpStatus: response?.status,
      httpHeaders: response?.headers,
      now: response?.time ?? message.timestamp,
      fatalFirst: config.rateLimit.fatalFirst,
      windowRetryMargin: config.rateLimit.windowRetryMargin,
    });

    if (classification.type === "RATE_LIMIT") {
      if (classification.expectedResetTime !== undefined) lastExpectedTokenResetTime = classification.expectedResetTime;
      const remainingResetDelay = classification.expectedResetTime !== undefined
        ? Math.max(0, classification.expectedResetTime - Date.now())
        : classification.retryAfterMs;
      const result = retryManager.evaluateRetry(
        config, classification.errorMessage || classification.reason, remainingResetDelay,
        Date.now(), classification.expectedResetTime, classification.retryAfterHeaderReceived,
        true, classification.isWindowEstimate
      );
      scheduleRecovery(result, "RATE_LIMIT", ctx, classification);
    } else if (classification.type === "TOKEN_LIMIT" || classification.type === "INCOMPLETE_TOOL_CALL") {
      scheduleRecovery(
        retryManager.evaluateContinuation(config, classification.type, classification.reason),
        classification.type, ctx, classification
      );
    } else {
      const state = retryManager.getState();
      if (classification.type === "CONTEXT_OVERFLOW") {
        notify(ctx, "Context overflow: no continuation sent. Pi owns compaction recovery; check its compaction result.");
      } else if (classification.type === "BILLING_HARD_LIMIT") {
        notify(ctx, `Non-retryable error: "${truncateErrorMessage(classification.errorMessage)}". Check your account or provider configuration.`, "error");
      } else if (message.stopReason === "stop" && state.isRetrying && state.attempt > 0) {
        notify(ctx, `Response completed after ${state.attempt} retry/continuation attempt(s) (total time: ${formatDuration(Date.now() - (state.startTime ?? Date.now()))}).`);
      }
      retryManager.reset();
    }
  });

  const commandHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const trimmedArgs = args.trim();
    const subcommand = trimmedArgs.toLowerCase();
    if (/^at(\s+.*)?$/i.test(trimmedArgs)) {
      const timeArg = trimmedArgs.replace(/^at\s*/i, "").trim();
      if (!timeArg) {
        notify(ctx, "Please specify a time in HH:MM format (e.g. /auto-continue at 14:30).", "warning");
        return;
      }
      const parsed = parseTargetTime(timeArg);
      if (!parsed) {
        notify(ctx, `Invalid time format "${timeArg}". Please use HH:MM (e.g. /auto-continue at 14:30).`, "warning");
        return;
      }
      if (shuttingDown) {
        notify(ctx, "Session completion is pending. Send fresh user input before scheduling another retry.", "warning");
        return;
      }
      resetRecovery();
      suppressRecovery = false;
      config.enabled = true;
      config.rateLimit.enabled = true;
      scheduleRecovery(retryManager.scheduleRetry(config, parsed.targetTimeMs), "RATE_LIMIT", ctx, undefined, true);
      return;
    }

    if (subcommand === "status" || subcommand === "") {
      const state = retryManager.getState();
      const retryInfo = dispatched
        ? "Continuation submitted; waiting for a turn to start (30s acknowledgement timeout)"
        : state.isRetrying
          ? `Active (attempt #${state.attempt}, elapsed: ${formatDuration(Date.now() - (state.startTime ?? Date.now()))}, last delay: ${formatDelay(state.lastDelayMs)})`
          : "Idle (no active retry loop)";
      const rateLimitLimit = parseMaxRetries(config.rateLimit.maxRetries ?? DEFAULT_RATE_LIMIT_MAX_RETRIES);
      const rateLimitLines = [
        "  Rate Limit Settings & Status:",
        `    Retry: ${config.rateLimit.enabled ? "enabled" : "disabled"}`,
        `    Base delay: ${formatDelay(parseDuration(config.rateLimit.baseDelayMs, DEFAULT_RATE_LIMIT_BASE_DELAY_MS))}`,
        `    Max delay: ${formatDelay(parseDuration(config.rateLimit.maxDelayMs, DEFAULT_RATE_LIMIT_MAX_DELAY_MS))}`,
        `    Max retries: ${formatMaxRetries(rateLimitLimit)}`,
        `    Jitter: ${config.rateLimit.jitter ? "enabled" : "disabled"}`,
      ];
      const resetTime = state.expectedTokenResetTime ?? lastExpectedTokenResetTime;
      if (resetTime !== undefined) {
        const remaining = Math.max(0, resetTime - Date.now());
        rateLimitLines.push(`    Expected token reset time: ${formatDateTime(resetTime)}${remaining > 0 ? ` (in ${formatDelay(remaining)})` : " (passed)"}`);
      }
      notify(ctx,
        `Auto-Continue Status:\n  Global:\n` +
        `    Enabled: ${config.enabled ? "yes" : "no"}\n` +
        `    Subagent session: ${isSubagentSession() ? "yes" : "no"}${isSubagentSession() && !config.subagent ? " (auto-continue inactive)" : ""}\n` +
        `    Shutdown pending (done-tool ran): ${shuttingDown ? "yes" : "no"}\n` +
        `    Base delay / Max delay: ${formatDelay(config.baseDelayMs)} / ${formatDelay(config.maxDelayMs)}\n` +
        `    Max retries: ${formatMaxRetries(parseMaxRetries(config.maxRetries))}\n` +
        `    Backoff multiplier: ${config.backoffMultiplier}x\n` +
        `    Current retry status: ${retryInfo}\n\n` + rateLimitLines.join("\n")
      );
    } else if (subcommand === "on" || subcommand === "enable") {
      config.enabled = true;
      notify(ctx, "Auto-continue enabled");
    } else if (subcommand === "off" || subcommand === "disable") {
      config.enabled = false;
      stopRecovery();
      notify(ctx, "Auto-continue disabled");
    } else if (subcommand === "reset") {
      stopRecovery();
      config = loadConfig(customSettingsPath);
      notify(ctx, "Counters and retry state reset; settings reloaded");
    } else {
      notify(ctx, "Usage: /auto-continue [status | on | off | reset | at <HH:MM>]");
    }
  };

  pi.registerCommand("auto-continue", {
    description: "Check auto-continue status or configure settings",
    handler: commandHandler,
  });
}
