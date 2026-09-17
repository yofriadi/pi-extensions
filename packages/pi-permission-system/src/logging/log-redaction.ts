import { createJsonSafeReplacer } from "./json-safe-stringify";

/**
 * Name-based redaction for the permission logs.
 *
 * The technique is deliberately structural rather than predictive: a value is
 * masked because of the *name* it is bound to, never because of what it looks
 * like. Value-shape secret detection (provider prefixes, entropy heuristics)
 * was measured against a real 6.7 MB review log and declined — see
 * `docs/decisions/0010-permission-log-secret-exposure.md`.
 *
 * This module owns the predicate and the log-key binding form.
 * `command-redaction.ts` asks the same predicate about the names a bash
 * command binds values to.
 *
 * The boundary that follows, stated once: a value bound to a sensitive name is
 * masked — whether the name is a log key, a shell variable, or a request
 * header field. A secret with no name bound to it, such as one typed as a
 * `grep` pattern, is not.
 */

export const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Names that bind a credential, matched case-insensitively.
 *
 * `api[-_]?keys?` and `private[-_]?keys?` are kept alongside the general
 * name-boundary `key` rule rather than subsumed by it, so the whole predicate
 * is a union with the pattern it replaced and can add a name but never drop
 * one — the separator-less `apikey` matches only via the specific alternative.
 */
const SENSITIVE_NAME_PATTERN =
  /authorization|api[-_]?keys?|private[-_]?keys?|secret|token|password|passwd|credential|cookie|(?:^|[-_])keys?(?:$|[-_])/i;

/**
 * A `key` bound as the tail of a camel-cased name (`apiKey`, `sortKeys`).
 *
 * Deliberately case-sensitive and separate from the pattern above: under `/i`
 * the leading `[a-z0-9]` would match an uppercase letter and `Key` would match
 * `key`, so `monkey` would read as sensitive.
 */
const CAMEL_KEY_PATTERN = /[a-z0-9](?:Key|Keys)(?:$|[A-Z_-])/;

/** True when a name binds a credential-bearing value. */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(name) || CAMEL_KEY_PATTERN.test(name);
}

/**
 * `safeJsonStringify` with sensitive-keyed values masked.
 *
 * Masking runs inside the replacer, so the structure beneath a sensitive key
 * is never visited and the traversal's existing cycle guard is reused — one
 * walk, not two. A `null` or `undefined` value is left alone so an absent
 * field does not read as a suppressed one.
 */
export function redactedJsonStringify(value: unknown): string | undefined {
  return JSON.stringify(
    value,
    createJsonSafeReplacer((key, currentValue) =>
      currentValue != null && isSensitiveName(key)
        ? REDACTED_PLACEHOLDER
        : currentValue,
    ),
  );
}
