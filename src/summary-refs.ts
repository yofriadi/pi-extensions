import type { CapturedBatch } from "./types.js";
import { resultTimestampOf } from "./occurrence-key.js";

export interface SummaryToolCallRef {
  shortId: string;
  toolCallId: string;
  /** ToolResultMessage timestamp; combines with toolCallId into the occurrence key. */
  resultTimestamp?: number;
}

export interface SummaryMessageDetailsLike {
  toolCallRefs?: SummaryToolCallRef[];
  toolCallIds?: string[];
}

const SHORT_ID_PREFIX = "t";
const SUMMARY_CONTEXT_TAG = "context-prune-summary";
export const SUMMARY_CONTEXT_OPEN = `<${SUMMARY_CONTEXT_TAG}>`;
export const SUMMARY_CONTEXT_CLOSE = `</${SUMMARY_CONTEXT_TAG}>`;
/**
 * The original's verbose preamble (Jun-25 form), kept ONLY so
 * `unwrapSummaryForDisplay` can strip it from legacy session content.
 * New summaries use the tag-only wrapper.
 */
export const LEGACY_SUMMARY_CONTEXT_NOTICE_LINES = [
  "Internal pruner context; not a user request.",
  "Do not answer directly; use only for prior tool-output context.",
] as const;
const LEGACY_SUMMARY_CONTEXT_NOTICE = LEGACY_SUMMARY_CONTEXT_NOTICE_LINES.join("\n");

export function buildShortToolCallRefs(
  calls: { toolCallId: string; resultTimestamp?: number }[],
  startIndex: number,
): { refs: SummaryToolCallRef[]; nextIndex: number } {
  const refs = calls.map((call, offset) => ({
    shortId: `${SHORT_ID_PREFIX}${startIndex + offset}`,
    toolCallId: call.toolCallId,
    ...(call.resultTimestamp !== undefined ? { resultTimestamp: call.resultTimestamp } : {}),
  }));
  return { refs, nextIndex: startIndex + refs.length };
}

export function normalizeSummaryToolCallRefs(details: unknown): SummaryToolCallRef[] {
  if (!details || typeof details !== "object") return [];

  const raw = details as SummaryMessageDetailsLike;
  if (Array.isArray(raw.toolCallRefs)) {
    return raw.toolCallRefs
      .filter(
        (ref): ref is SummaryToolCallRef =>
          !!ref && typeof ref.shortId === "string" && typeof ref.toolCallId === "string",
      )
      .map((ref) => {
        const resultTimestamp = resultTimestampOf((ref as any).resultTimestamp);
        return {
          shortId: ref.shortId,
          toolCallId: ref.toolCallId,
          ...(resultTimestamp !== undefined ? { resultTimestamp } : {}),
        };
      });
  }

  if (Array.isArray(raw.toolCallIds)) {
    return raw.toolCallIds.filter((id): id is string => typeof id === "string").map((id) => ({ shortId: id, toolCallId: id }));
  }

  return [];
}

export function formatSummaryToolCallRefs(refs: SummaryToolCallRef[]): string {
  const refList = refs.map((ref) => `\`${ref.shortId}\``).join(", ");
  return (
    `\n\n---\n**Summarized tool refs**: ${refList}\n` +
    `Use \`context_tree_query\` with these refs to retrieve the original full outputs.`
  );
}

/**
 * Wraps a flush-time summary body in the `<context-prune-summary>` tag pair,
 * marking it as pruner-generated internal context for the LLM. Idempotent:
 * content already starting with the open tag is returned trimmed, never
 * double-wrapped.
 */
export function wrapSummaryForContext(summaryText: string): string {
  const trimmed = summaryText.trim();
  if (trimmed.startsWith(SUMMARY_CONTEXT_OPEN)) {
    return trimmed;
  }

  return `${SUMMARY_CONTEXT_OPEN}\n${summaryText}\n${SUMMARY_CONTEXT_CLOSE}`;
}

/**
 * Display-side inverse of `wrapSummaryForContext`: strips the wrapper (and
 * legacy notice lines) from summary content before rendering. Strip-or-
 * passthrough semantics — recognized wrappers are removed; unwrapped legacy
 * content, malformed wrappers, and non-strings pass through unchanged.
 * Never throws.
 */
export function unwrapSummaryForDisplay(content: unknown): string {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => {
              if (!part || typeof part !== "object") return "";
              if (!("type" in part) || (part as { type?: unknown }).type !== "text") return "";
              return "text" in part && typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "";
            })
            .filter(Boolean)
            .join("\n")
        : "";

  const trimmed = raw.trim();
  if (!trimmed.startsWith(SUMMARY_CONTEXT_OPEN) || !trimmed.endsWith(SUMMARY_CONTEXT_CLOSE)) {
    return raw;
  }

  const closeStart = trimmed.lastIndexOf(SUMMARY_CONTEXT_CLOSE);
  if (closeStart <= SUMMARY_CONTEXT_OPEN.length) {
    return raw;
  }

  let inner = trimmed.slice(SUMMARY_CONTEXT_OPEN.length, closeStart).trim();
  const lines = inner.split(/\r?\n/);
  const noticePrefix = lines.slice(0, LEGACY_SUMMARY_CONTEXT_NOTICE_LINES.length).join("\n");
  const blankLineIndex = LEGACY_SUMMARY_CONTEXT_NOTICE_LINES.length;
  if (noticePrefix === LEGACY_SUMMARY_CONTEXT_NOTICE) {
    const hasSeparator = lines.length > blankLineIndex && lines[blankLineIndex].trim() === "";
    inner = lines.slice(blankLineIndex + (hasSeparator ? 1 : 0)).join("\n").trim();
  }
  return inner;
}

export function makeSummaryDetails(batch: CapturedBatch, refs: SummaryToolCallRef[]) {
  return {
    toolCallRefs: refs,
    toolNames: batch.toolCalls.map((tc) => tc.toolName),
    turnIndex: batch.turnIndex,
    timestamp: batch.timestamp,
  };
}

/**
 * Rewrites line-leading `[[N:name]]` labels emitted by the summarizer into
 * inline `` `tN` `` refs. `refs` and `toolNames` are positionally aligned to
 * the batch's tool-call order. The echoed name is validated against the tool
 * at position N; a mismatch or out-of-range N strips the label (footer-only).
 * A catch-all strip pass on non-fenced lines removes any surviving well-formed
 * label token (wrapped, numbered, or blockquoted) so no raw `[[N:name]]` token
 * ever leaks into context; fenced code blocks remain exempt.
 */
export function substituteInlineRefs(
  text: string,
  refs: SummaryToolCallRef[],
  toolNames: string[],
): string {
  const LABEL = /^(\s*(?:[-*]\s+)?)\[\[(\d+):([^\]\n]+)\]\]\s*/;
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = lines[i].replace(LABEL, (_m, prefix: string, numStr: string, name: string) => {
      const n = Number(numStr);
      const ref = refs[n - 1];
      const expected = toolNames[n - 1];
      if (!ref || expected === undefined) return prefix;
      if (name.trim().toLowerCase() !== expected.trim().toLowerCase()) return prefix;
      return `${prefix}\`${ref.shortId}\` `;
    });
    lines[i] = lines[i].replace(/\[\[\d+:[^\]\n]+\]\]\s*/g, "");
  }
  return lines.join("\n");
}
