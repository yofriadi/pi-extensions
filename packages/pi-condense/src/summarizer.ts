import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizerThinking,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeResult,
} from "./types.js";
import { serializeBatchForSummarizer } from "./batch-capture.js";
import { FallbackController, type FallbackTransition } from "./summarizer-fallback.js";
import {
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_MAX_WAIT_MS,
  RATE_LIMIT_RETRIES,
  RateLimitGate,
  isRateLimited,
  parseRetryDelayMs,
  sleep as pacingSleep,
} from "./summarizer-pacing.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome, plus any file paths, identifiers, signatures, or error strings copied verbatim - never reword these
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Skip calls that succeeded with nothing reusable to record. Be concise.

Begin the first bullet of each tool call with that tool's [[N:toolname]] label, copied verbatim (both the number and the name) from its line in the input, as the plain, first thing on the line - no bold, backticks, or list numbering around it. Do not renumber, rename, or invent labels; if you skip a tool, skip its label too.`;

const RANGE_SYSTEM_PROMPT = `You are fusing several per-step summaries of one CLOSED sub-task from an AI coding assistant's history into a SINGLE cohesive summary.
- Merge overlapping or repeated information; do not restate each step separately.
- Preserve concrete outcomes, decisions, file paths, identifiers, and anything later work needs to remember.
- Keep any reference tokens like \`t12\` or \`b3\` intact.
- Be concise: a short narrative or a few grouped bullets, not one bullet per step.`;

export function summarizerThinkingOptions(
  config: ContextPruneConfig,
  model: Pick<Model<Api>, "reasoning">
 ): SimpleStreamOptions {
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default" || level === "off" || !model.reasoning) {
    return {};
  }

  return { reasoning: level };
}

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): Model<Api> | undefined {
  if (config.summarizerModel === "default") {
    return ctx.model;
  }

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  return found;
}

function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => {
    return content.type === "text" ? sum + content.text.length : sum;
  }, 0);
}

/** A summary is usable only if it has non-whitespace text and was not truncated. */
export function isUsableSummary(llmText: string, stopReason: string): boolean {
  return llmText.trim().length > 0 && stopReason !== "length";
}

type RunOutcome =
  | { kind: "ok"; result: SummarizeResult }
  | { kind: "auth"; message: string }
  | { kind: "unusable" }
  | { kind: "transient"; message: string; timedOut?: boolean };

/** Human label for a model in notify text: prefer name, fall back to provider/id. */
function modelLabel(model: Model<Api> | undefined): string {
  if (!model) return "unknown model";
  return model.name || `${model.provider}/${model.id}`;
}

/** Combines any present abort signals into one; undefined if none are given. */
function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present); // Node 20+; host runtime is node 24.5.0
}

/**
 * One summarization attempt against a specific model. Returns a classified
 * outcome instead of throwing (except aborts, which propagate so flushPending
 * can restore state). Auth failure is detected pre-stream and never reaches
 * the fallback path. `unusable` = empty or length-truncated. Everything else
 * that reaches the catch is `transient` (the outage bucket) — pi-ai surfaces
 * no structured status code on the throw, so classification is coarse by design.
 */
async function runAttempt(
  model: Model<Api> | undefined,
  userMessage: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions
): Promise<RunOutcome> {
  const idleMs = config.summarizerIdleTimeoutMs;
  const maxMs = config.summarizerMaxTimeoutMs;
  const timeoutController = new AbortController();
  let timedOut = false;
  let timeoutKind: "idle" | "ceiling" | null = null;
  let idleTimerId: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimerId: ReturnType<typeof setTimeout> | null = null;

  const bumpIdle = () => {
    if (idleTimerId !== null) clearTimeout(idleTimerId);
    if (idleMs > 0) {
      idleTimerId = setTimeout(() => {
        timedOut = true;
        timeoutKind = "idle";
        timeoutController.abort();
      }, idleMs);
    }
  };
  const timeoutMessage = () =>
    timeoutKind === "ceiling"
      ? `summarizer ${modelLabel(model)} exceeded ${Math.round(maxMs / 1000)}s ceiling`
      : `summarizer ${modelLabel(model)} stalled (no output for ${Math.round(idleMs / 1000)}s)`;

  try {
    if (!model) {
      return { kind: "transient", message: "no summarizer model selected" };
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      return { kind: "auth", message: authMessage };
    }

    // Mirror the main loop (model-runtime stream): auth resolution can carry a
    // seat-specific baseUrl (e.g. GitHub Copilot business/enterprise endpoints).
    // The shipped model data pins the individual host, which 421s other seats,
    // so the resolved auth baseUrl must win over the static model baseUrl.
    const providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
    const effectiveModel = providerAuth?.auth.baseUrl
      ? { ...model, baseUrl: providerAuth.auth.baseUrl }
      : model;
    const provider = ctx.modelRegistry.getProvider(effectiveModel.provider);
    if (!provider) {
      return { kind: "transient", message: `provider not found: ${effectiveModel.provider}` };
    }

    // Pi extensions register custom APIs on the host ModelRegistry, not pi-ai's
    // compatibility-global registry. Dispatch through the composed host provider
    // so custom streamSimple handlers (such as Antigravity) are available.
    const responseStream = provider.streamSimple(
      effectiveModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: combineSignals(options.signal, timeoutController.signal),
        ...summarizerThinkingOptions(config, effectiveModel),
      }
    );

    // Ceiling arms once at call start; idle arms/resets on every stream event
    // (including before the first one, so it also bounds time-to-first-token).
    if (maxMs > 0) {
      ceilingTimerId = setTimeout(() => {
        timedOut = true;
        timeoutKind ??= "ceiling";
        timeoutController.abort();
      }, maxMs);
    }
    bumpIdle();

    let lastReportedChars = -1;
    options.onTextProgress?.(0);
    const reportTextProgress = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      // Reset idle on ANY event (text_* and thinking_*), not just text — a
      // reasoning-heavy model stays alive via thinking_delta and is never
      // false-aborted for being quiet on text while it reasons.
      bumpIdle();
      // Belt-and-suspenders: break early when signal fires mid-stream.
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        reportTextProgress(event.partial);
      }
    }

    // If signal fired while we were iterating, propagate the abort so
    // flushPending can detect it and restore batches.
    if (options.signal?.aborted) throw new Error("summarize: aborted during stream");

    const response = await responseStream.result();
    reportTextProgress(response);
    // stopReason "aborted" means the provider cut the stream short (e.g. signal
    // fired just before the final chunk). Treat identically to the signal check
    // above — throw so the catch below can detect options.signal.aborted.
    if (response.stopReason === "aborted") {
      throw new Error("summarize: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      if (timedOut) return { kind: "transient", message: timeoutMessage(), timedOut: true };
      return { kind: "transient", message: response.errorMessage ?? "Summarizer stopped with reason: error" };
    }

    const llmText = response.content.reduce(
      (text, content) => (content.type === "text" ? `${text}${text ? "\n" : ""}${content.text}` : text),
      ""
    );

    if (!isUsableSummary(llmText, response.stopReason)) return { kind: "unusable" };

    return { kind: "ok", result: { summaryText: llmText, usage: response.usage } };
  } catch (err: unknown) {
    // Propagate abort errors upward so flushPending can check signal.aborted
    // and return { ok: false, reason: "aborted" } without showing a UI error.
    if (options.signal?.aborted) throw err;
    if (timedOut) return { kind: "transient", message: timeoutMessage(), timedOut: true };
    return { kind: "transient", message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (idleTimerId !== null) clearTimeout(idleTimerId);
    if (ceilingTimerId !== null) clearTimeout(ceilingTimerId);
  }
}

/**
 * Rate-limit retry loop around runAttempt. Re-attempts the SAME model while
 * the outcome is rate-limit-shaped (up to `pacing.retries` extra attempts),
 * waiting BETWEEN attempts so each attempt arms fresh idle/ceiling timers and
 * a wait is never mistaken for a stall. Emits no notification - runSummarization
 * still sees a single final outcome. A parsed server delay above the per-wait
 * cap, a `timedOut` transient, auth/unusable/ok, and unrecognized failures all
 * return immediately; aborts propagate (no swallow, no retry). When
 * summarizerMaxTimeoutMs > 0 no retry starts whose planned wait would push
 * elapsed time past the ceiling.
 */
async function runOnce(
  model: Model<Api> | undefined,
  userMessage: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions
): Promise<RunOutcome> {
  const pacing = options.pacing;
  const retries = pacing?.retries ?? RATE_LIMIT_RETRIES;
  const baseDelayMs = pacing?.baseDelayMs ?? RATE_LIMIT_BASE_DELAY_MS;
  const maxWaitMs = pacing?.maxWaitMs ?? RATE_LIMIT_MAX_WAIT_MS;
  const sleepFn = pacing?.sleep ?? pacingSleep;
  const now = pacing?.now ?? Date.now;
  const startedAt = now();
  const maxMs = config.summarizerMaxTimeoutMs;
  let lastTransient: Extract<RunOutcome, { kind: "transient" }> | undefined;

  for (let attempt = 0; ; attempt++) {
    // Park behind a fan-out-mate's backoff before spending an attempt.
    await pacing?.gate?.wait(options.signal);
    // A pool-mate may have extended the gate past our ceiling while we waited -
    // don't start another attempt once the budget is already blown.
    if (attempt > 0 && lastTransient && maxMs > 0 && now() - startedAt > maxMs) {
      return lastTransient;
    }
    const outcome = await runAttempt(model, userMessage, config, ctx, options);
    if (outcome.kind !== "transient" || outcome.timedOut || !isRateLimited(outcome.message)) {
      return outcome;
    }

    const serverDelayMs = parseRetryDelayMs(outcome.message);
    // A server delay above the per-wait cap is a real outage, not a burst -
    // surface it as transient immediately (no penalty, no wait) so the
    // fallback path can take over.
    if (serverDelayMs !== undefined && serverDelayMs > maxWaitMs) return outcome;
    const delayMs = serverDelayMs ?? Math.min(baseDelayMs * 2 ** attempt, maxWaitMs);

    // Every rate-limit failure paces the pool - including one we won't retry
    // locally, so pool-mates don't unpark into the wall that just 429'd us.
    pacing?.gate?.penalize(delayMs);

    if (attempt >= retries) return outcome;
    // Keep the retry chain roughly inside the user's ceiling when one is set.
    if (maxMs > 0 && now() - startedAt + delayMs > maxMs) return outcome;

    lastTransient = outcome;
    await sleepFn(delayMs, options.signal);
  }
}

/**
 * Shared LLM-call machinery for both per-batch and range summarization.
 * `userMessage` already embeds the relevant system prompt as leading text
 * (the summarizer is a single-user-message call). Returns the formatted text
 * + usage, or null on failure. Abort errors are re-thrown so flushPending can
 * detect options.signal.aborted and restore state without a UI error.
 *
 * When options.controller is set AND a distinct fallback model exists, a
 * transient failure of the configured summarizer model is retried once on the
 * session model, and the controller stays sticky in fallback until a
 * per-cooldown probe of the primary succeeds.
 */
async function runSummarization(
  userMessage: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions
): Promise<SummarizeResult | null> {
  // Fast-fail if already aborted before we even start.
  if (options.signal?.aborted) throw new Error("summarize: aborted before start");

  const primary = resolveModel(config, ctx);
  const controller = options.controller;
  const sessionModel = ctx.model;

  const notifyFailure = (o: { message: string; timedOut?: boolean }) =>
    ctx.ui.notify(
      o.timedOut
        ? `pi-condense: ${o.message}; summarizer call abandoned`
        : `pruner: summarization failed: ${o.message}`,
      o.timedOut ? "warning" : "error",
    );

  // No controller or no distinct fallback: single attempt, legacy behavior.
  if (!controller || !FallbackController.hasDistinctFallback(primary, sessionModel)) {
    const r = await runOnce(primary, userMessage, config, ctx, options);
    switch (r.kind) {
      case "ok":
        return r.result;
      case "auth":
      case "transient":
        notifyFailure(r);
        return null;
      case "unusable":
        return null;
    }
  }

  const emit = (t: FallbackTransition, detail?: string) => {
    if (t === "enter") {
      ctx.ui.notify(
        `pi-condense: summarizer model ${modelLabel(primary)} failing, using session model ${modelLabel(sessionModel)} until it recovers${detail ? `: ${detail}` : ""}`,
        "warning"
      );
    } else if (t === "recover") {
      ctx.ui.notify(`pi-condense: summarizer model ${modelLabel(primary)} recovered`, "info");
    }
  };

  const decision = controller.chooseTarget();
  const model = decision.target === "primary" ? primary : sessionModel;
  const r = await runOnce(model, userMessage, config, ctx, options);

  switch (r.kind) {
    case "ok":
      if (decision.target === "primary") emit(controller.onPrimarySuccess(decision.wasProbe));
      else emit(controller.onFallbackSuccess());
      return r.result;
    case "auth":
      notifyFailure(r); // auth never trips the controller
      return null;
    case "unusable":
      return null; // probe unusable => stay (no state change)
    case "transient": {
      if (decision.target === "fallback") {
        controller.onFallbackOnlyFail();
        notifyFailure(r);
        return null;
      }
      // target was primary (initial detection or probe): retry once on the session model.
      const r2 = await runOnce(sessionModel, userMessage, config, ctx, options);
      if (r2.kind === "ok") {
        emit(controller.onPrimaryFailFallbackOk(decision.wasProbe), r.message);
        return r2.result; // suppress the legacy error notify — fallback rescued the call
      }
      controller.onBothDown();
      notifyFailure(r2.kind === "transient" || r2.kind === "auth" ? r2 : r);
      return null;
    }
  }
}

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeResult | null> {
  const serialized = serializeBatchForSummarizer(batch);
  const userMessage =
    SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";
  return runSummarization(userMessage, config, ctx, options);
}

/**
 * Fuses a closed chain's already-computed per-batch summaries into one cohesive
 * range summary (recursive summarization). Input is the span's per-batch summary
 * text — small and already pruned — so this never re-sends raw tool output.
 * Returns the fused text + usage, or null on failure. Used by chain compression
 * to replace the concatenated per-batch body with a single coherent summary.
 */
export async function summarizeRange(
  perBatchSummaryText: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeResult | null> {
  const userMessage =
    RANGE_SYSTEM_PROMPT + "\n\n<sub-task-summaries>\n" + perBatchSummaryText + "\n</sub-task-summaries>";
  return runSummarization(userMessage, config, ctx, options);
}

/**
 * Summarizes multiple captured batches — one LLM call per batch, run through a
 * bounded worker pool of `config.summarizerConcurrency` workers (`0` = one
 * worker per batch, i.e. unbounded). Results stay index-aligned with the input
 * array, and per-batch progress callbacks keep their (index, total) semantics.
 *
 * Returns an array of per-batch results. Each element is either a SummarizeResult
 * (success) or null (that specific batch's call failed). The array length always
 * equals batches.length so callers can zip by index.
 *
 * Rationale for parallel-per-batch instead of a single merged call:
 *   • Each batch becomes its own summary message (one per turn), so they can be
 *     rendered, browsed, and recovered independently via context_tree_query.
 *   • Bounded-parallel calls keep end-to-end latency close to a single merged
 *     call without stampeding the summarizer provider's rate limit when a large
 *     backlog flushes at once (budget auto-flush).
 *   • One RateLimitGate per fan-out is shared by every call in the pool: the
 *     first call to hit a quota wall parks the whole pool for its backoff
 *     window instead of each worker retrying into the same wall.
 *
 * Abort: the first thrown error stops the pool from handing out queued batches,
 * in-flight calls settle (they share the aborted signal), then the error is
 * re-thrown so flushPending can restore pending batches.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  // One gate per fan-out, shared by every call in it (never persisted across
  // flushes). A caller-injected gate (tests) wins.
  const pacing = {
    ...options.pacing,
    gate: options.pacing?.gate ?? new RateLimitGate(options.pacing?.now),
  };
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    return [
      await summarizeBatch(batches[0], config, ctx, {
        signal: options.signal,
        controller: options.controller,
        pacing,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(0, 1, batches[0], receivedChars);
        },
      }),
    ];
  }

  // Multiple batches — fixed-size worker pool over a shared cursor; each
  // worker pulls the next index, so a queued batch starts only as an in-flight
  // call settles. `cursor++` is synchronous, so index hand-out needs no lock.
  const width = config.summarizerConcurrency || batches.length;
  const workerCount = Math.min(width, batches.length);
  const results: Array<SummarizeResult | null> = new Array(batches.length);
  let cursor = 0;
  let hasError = false;
  let firstError: unknown;

  const worker = async () => {
    while (!hasError) {
      const index = cursor++;
      if (index >= batches.length) return;
      const batch = batches[index];
      try {
        results[index] = await summarizeBatch(batch, config, ctx, {
          signal: options.signal,
          controller: options.controller,
          pacing,
          onTextProgress: (receivedChars) => {
            options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
          },
        });
      } catch (err) {
        // Separate flag: a thrown value could itself be undefined/null.
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        return;
      }
    }
  };

  // Workers never reject (they capture into firstError), so this awaits every
  // in-flight call before the captured error is re-thrown.
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (hasError) throw firstError;
  return results;
}
