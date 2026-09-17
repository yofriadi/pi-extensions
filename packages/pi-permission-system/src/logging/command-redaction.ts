import {
  ARG_NODE_TYPES,
  resolveNodeText,
} from "#src/access-intent/bash/node-text";
import { getWarmBashParser, type TSNode } from "#src/access-intent/bash/parser";
import { isPlainRecord } from "#src/value-guards";
import { isSensitiveName, REDACTED_PLACEHOLDER } from "./log-redaction";

/**
 * Grammar-anchored masking of a secret bound to a sensitive name *inside* a
 * bash command string.
 *
 * Key-name redaction (`log-redaction.ts`) masks a value because of the key it
 * is bound to, and a command string is one opaque value under the key
 * `command`. This module asks the same question of the names a command binds
 * values to — a shell variable and an HTTP header field — so one predicate
 * answers for all three binding forms.
 *
 * Every rule matches a **parse node**, never a substring of the command text.
 * That is what keeps it usable: measured against a 12 MB review log (7146
 * unique commands), a raw-string scan for a sensitively-named assignment
 * matched ten commands and every one was embedded Python (`key=lambda x: x[1]`)
 * or a `sed` pattern; the same rule anchored to a `variable_assignment` node
 * matched none. See `docs/decisions/0010-permission-log-secret-exposure.md`.
 *
 * A value with no name bound to it — a secret typed as a `grep` pattern — is
 * out of reach of a structural rule and stays unmasked.
 */

/** The log keys whose value is a bash command string. */
export const COMMAND_BEARING_LOG_KEYS: ReadonlySet<string> = new Set([
  "command",
  "executedUnit",
]);

/** A range of the command to replace, and what to put in its place. */
interface MaskSpan {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * Mask every sensitively-named value in a bash command string.
 *
 * Best-effort by design: a cold parser, a parse that throws, and a parse that
 * recovered from a syntax error all yield whatever the walk did resolve rather
 * than blanking the field, because the command text is the main reason the
 * review log is read. It never throws — the writer sits under the fail-closed
 * `tool_call` boundary, where a raised mask would cost the whole log line.
 */
export function redactCommandSecrets(command: string): string {
  if (!command) return command;

  try {
    const parser = getWarmBashParser();
    if (!parser) return command;
    const tree = parser.parse(command);
    if (!tree) return command;
    try {
      const spans: MaskSpan[] = [];
      collectMaskSpans(tree.rootNode, spans);
      return applyMaskSpans(command, spans);
    } finally {
      tree.delete();
    }
  } catch {
    return command;
  }
}

/**
 * Apply {@link redactCommandSecrets} to every command-bearing key in a log
 * record.
 *
 * Recurses through plain objects and arrays, like the width cap beside it: all
 * of today's producers write `command` and `executedUnit` at the top level, but
 * a writer stage that only looks at the top level is one a later nested
 * producer escapes without anyone noticing.
 */
export function maskCommandFields<T>(details: T): T {
  return maskValue(details, false) as T;
}

function maskValue(value: unknown, bindsCommand: boolean): unknown {
  if (typeof value === "string") {
    return bindsCommand ? redactCommandSecrets(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => maskValue(entry, bindsCommand));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        maskValue(entry, COMMAND_BEARING_LOG_KEYS.has(key)),
      ]),
    );
  }
  return value;
}

function collectMaskSpans(node: TSNode, spans: MaskSpan[]): void {
  const span = maskSpanOf(node);
  if (span) spans.push(span);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectMaskSpans(child, spans);
  }
}

function maskSpanOf(node: TSNode): MaskSpan | null {
  return (
    assignmentValueSpan(node) ??
    wordAssignmentSpan(node) ??
    headerValueSpan(node)
  );
}

/**
 * `KEY="sk-…" curl …`, `KEY=sk-…`, `export OPENROUTER_KEY="sk-…"`.
 *
 * The span runs to the assignment node's own end rather than the value node's,
 * so a value the grammar splits across several children is covered whole.
 */
function assignmentValueSpan(node: TSNode): MaskSpan | null {
  if (node.type !== "variable_assignment") return null;
  const name = node.child(0);
  if (!name || !isSensitiveName(name.text)) return null;
  const value = node.child(2);
  if (!value) return null;
  return maskSpan(value.startIndex, node.endIndex, REDACTED_PLACEHOLDER);
}

/**
 * `env MY_KEY=abc deploy`, which tree-sitter classifies as a plain `word`
 * rather than an assignment because it follows a command name.
 *
 * The name must open with a letter or underscore, so a long option
 * (`--my-key=abc`) cannot match: an option binds its value to a flag, and the
 * flag forms are deliberately out of scope.
 */
const WORD_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function wordAssignmentSpan(node: TSNode): MaskSpan | null {
  if (node.type !== "word") return null;
  const match = WORD_ASSIGNMENT.exec(node.text);
  if (!match || !isSensitiveName(match[1])) return null;
  return maskSpan(
    node.startIndex + match[0].length,
    node.endIndex,
    REDACTED_PLACEHOLDER,
  );
}

/** `curl -H "Authorization: Bearer sk-…"`, in any of its quoting forms. */
const HEADER_FIELD = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*\S/;

function headerValueSpan(node: TSNode): MaskSpan | null {
  if (!ARG_NODE_TYPES.has(node.type)) return null;
  const match = HEADER_FIELD.exec(resolveNodeText(node));
  const field = match?.[1];
  if (!field || !isSensitiveName(field) || isCamelCased(field)) return null;
  const colon = node.text.indexOf(":");
  if (colon < 0) return null;
  // The span swallows a closing quote, so the replacement puts one back and
  // the masked argument stays quoted the way it was written.
  return maskSpan(
    node.startIndex + colon + 1,
    node.endIndex,
    REDACTED_PLACEHOLDER + openQuoteAt(node.text, colon),
  );
}

/**
 * An HTTP field name is hyphenated (`X-Api-Key`), never camel-cased.
 *
 * Without this the only false positives in the measured corpus were two
 * records of `grep "legalDirectionalKeys: readonly"` — a search pattern over
 * TypeScript source, which names a field of nothing.
 */
function isCamelCased(field: string): boolean {
  return /[a-z][A-Z]/.test(field);
}

/**
 * The quote character still open at `index`, or the empty string.
 *
 * Read at the mask's own position rather than off the argument's first
 * character: a field name can straddle a quote boundary (`Auth"orization: "$T`),
 * and the quote the mask swallowed is the one open where it begins.
 */
function openQuoteAt(text: string, index: number): string {
  let quote = "";
  for (let i = 0; i < index; i++) {
    const char = text[i];
    if (quote === "") {
      if (char === '"' || char === "'") quote = char;
    } else if (quote === '"' && char === "\\") {
      i += 1;
    } else if (char === quote) {
      quote = "";
    }
  }
  return quote;
}

function maskSpan(
  start: number,
  end: number,
  replacement: string,
): MaskSpan | null {
  return start < end ? { start, end, replacement } : null;
}

/**
 * Replace each span, outermost-wins and right to left.
 *
 * A sensitive assignment whose value is itself a header argument yields two
 * spans, one inside the other; masking both would nest a placeholder inside a
 * region already replaced. Working right to left keeps the earlier offsets
 * valid as the string shortens.
 */
function applyMaskSpans(command: string, spans: MaskSpan[]): string {
  if (spans.length === 0) return command;

  const ordered = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const disjoint: MaskSpan[] = [];
  for (const span of ordered) {
    const previous = disjoint.at(-1);
    if (previous && span.start < previous.end) continue;
    disjoint.push(span);
  }

  let masked = command;
  for (const span of disjoint.toReversed()) {
    masked =
      masked.slice(0, span.start) + span.replacement + masked.slice(span.end);
  }
  return masked;
}
