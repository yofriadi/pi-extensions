---
issue: 920
issue_title: "Secret in a command string still reaches the review log; ADR 0010's reopen condition is met"
---

# Mask a secret bound to a sensitive name inside a logged bash command

## Release Recommendation

**Release:** ship independently

Issue [#920] is not a step in the Phase 15 roadmap — the phase's spine is token roles, declared effects, and the sandbox seam, and this is a `logging/` exposure.
It carries no `Release:` tag, so it is independently releasable.
The wiring step is a `fix:`, which cuts a patch on its own.

## Problem Statement

The permission review log is on by default and persists the complete bash command string in its `command` field.
Redaction masks a value because of the **key** it is bound to, so a command string — one opaque value under the key `command` — is never inspected.

A third-party reporter ([Radu0120]) measured a real install with `permissionReviewLog: true` and found 35 records holding a live API key verbatim, across three vectors:

| Vector                                       | Count |
| -------------------------------------------- | ----- |
| `KEY="<secret>"` env-prefix assignment       | 19    |
| `curl … -H "Authorization: Bearer <secret>"` | 8     |
| `grep` command containing the key            | 2     |
| other                                        | 6     |

ADR 0010 declined grammar-anchored bash redaction as "the option a future report reopens", to be revisited "should a report show a secret reaching the log through a command string".
That condition is met word for word.

The report also **corrects** the remedy ADR 0010 nominated.
The nominated rule masks the value of an assignment whose name is sensitive; the name actually used was `KEY`, and the shipped `SENSITIVE_KEY_PATTERN` has `api[-_]?key` and `private[-_]?key` but no bare or suffixed `key`.
Verified against `src/logging/log-redaction.ts`:

```text
KEY  false    key  false    OPENROUTER_KEY  false    MY_KEY  false
TOKEN  true   API_KEY  true          AUTH_TOKEN  true
```

So all 19 assignment-vector leaks would have been written unredacted even after the nominated rule landed.

## Goals

- Mask a value bound to a sensitive **name** inside a logged bash command string, in three binding forms: a shell `variable_assignment`, a `word`-shaped assignment (`env MY_KEY=abc deploy`), and an argument of the form `<sensitive-name>: <value>` (the `-H "Authorization: …"` vector).
- Anchor every rule to a tree-sitter **node**, never to a raw-string scan — measured below as the difference between zero and ten false positives.
- Widen the sensitive-name predicate so a bare or suffixed `key` matches, strictly adding to what the shipped pattern masks and removing nothing.
- Apply the pass at `writeLine`, the single place a log line is produced, so none of the three independent `command` producers has to remember it.
- Restate ADR 0010's boundary rather than delete it: the `grep`-pattern vector has no name attached and stays out of reach of any structural rule.

The change is **not breaking**.
The review log is a diagnostic artifact with no parser contract, and the change only removes content from it.
Nothing a user configures changes meaning, and the prompt path is untouched.

## Non-Goals

- **Value-shape secret detection.**
  Provider prefixes and entropy heuristics stay declined on ADR 0010's measured evidence.
  The `grep "sk-ant-oat01-…"` vector (2 of the report's 35) has no name bound to it and is therefore out of reach; the ADR amendment says so explicitly rather than implying the log is now secret-free.
- **Inline-shell payloads and heredoc bodies.**
  `bash -c 'TOKEN=abc deploy'` is a `raw_string`, and `cat > .env <<EOF` / `API_KEY=…` / `EOF` is a single `heredoc_body` token; neither carries an assignment node.
  Blanket recursion into strings is exactly what reintroduces the false-positive class (measured below), so a restricted widening needs the wrapper analyzer's answer threaded into the walk.
  Filed as [#923].
- **Flag-argument masking (`--token abc`, `--password abc`).**
  ADR 0010 nominated it; the report does not ask for it, the corpus contains zero occurrences of any such flag, and `sort --key 2` would be a false positive.
  The existing `logging.test.ts` case `deploy --token abc123` stays green and becomes the documented boundary example.
- **A new Windows mechanism.**
  The report's second gap is that `chmod` is a no-op on Windows.
  This change *is* the platform-independent remedy for the assignment and header vectors — redaction does not depend on file modes — so Windows gains one active remedy where it had none.
  ADR 0010's reasoning against a per-session Windows warning is unchanged.
- **The `permissions:decision` bus event.**
  Its `value` carries the command for an in-process consumer.
  It is not persisted by this package and is governed by ADR 0011 §6, not ADR 0010.
- **A downstream redactor registry.**
  Still declined for want of a consumer (ADR 0010).

## Background

### Where a command reaches the log

`writeLine` (`src/logging/logging.ts:59`) is the only place a log line is produced.
It caps every string for the review stream (`capLogFieldWidths`), then serializes through `redactedJsonStringify`, which masks a value whose **key** is sensitive.

Three independent producers put a bash command string into the details record:

- `ToolPreviewFormatter.getPermissionLogContext` (`src/tool-input/tool-preview-formatter.ts:170`) — `command: result.command`, reaching the log through both `describeToolGate`'s `logContext` and `PermissionPrompter.writeReviewEntry`.
- `renderReviewLogFacts` (`src/presentation/review-log-renderer.ts:29`) — `executedUnit`, the inner command of a wrapper unit.
- `recordGateError` (`src/handlers/tool-call-boundary.ts:88`) — `bestEffortCommand(event)` on the fail-closed path, which borrows no gate's context.

A producer-side fix would have to be remembered at all three, which is the argument `capLogFieldWidths` already makes in its own doc comment for living at the writer.

### The parse is already available synchronously

`warmBashParser` runs at `before_agent_start`, ahead of any tool call, and `getWarmBashParser()` hands the warmed parser out synchronously (`src/access-intent/bash/parser.ts`).
`parseBashCommandsSync` is the existing precedent for a synchronous consumer.
The local `TSNode` interface carries `startIndex` but not `endIndex`, which a span-based masker needs.

### Constraints from AGENTS.md and the package skill

- The boundary sentence *"a value bound to a sensitive key name is masked; a secret embedded in a bash command string is not"* is repeated verbatim in five places (ADR 0010, `docs/configuration.md`, `docs/troubleshooting.md`, `README.md`'s non-goal, the package SKILL).
  It is being rewritten, not deleted, and every copy must move together.
- `docs/migration/0746-review-log-fields.md` repeats it too, describing a past release.
  Predicted unchanged — see Module-Level Changes.
- ADR 0010 is `status: accepted` and stays accepted; this is an amendment to it, in the same style as ADR 0013's dated amendment.
- The prompt is never redacted (ADR 0010), and the forwarding request/response files are never redacted because the parent renders the ask from them.

## Design Overview

### The one predicate, three binding forms

A name binds a value in three ways this package writes to disk: a JSON log key, a shell variable name, and an HTTP header field name.
One predicate answers all three, which is what keeps the boundary statable in one sentence.

```typescript
// src/logging/log-redaction.ts
const SENSITIVE_NAME_PATTERN =
  /authorization|api[-_]?keys?|private[-_]?keys?|secret|token|password|passwd|credential|cookie|(?:^|[-_])keys?(?:$|[-_])/i;

/** Case-sensitive: `/i` here would make `monkey` match `[a-z0-9]Key`. */
const CAMEL_KEY_PATTERN = /[a-z0-9](?:Key|Keys)(?:$|[A-Z_-])/;

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(name) || CAMEL_KEY_PATTERN.test(name);
}
```

The delta is smaller than the report's suffix list suggests.
`token`, `secret`, `password`, and `credential` are already **substring** alternatives and so already wider than a suffix match.
The only genuine widening is `key` with a name boundary, which subsumes the shipped `api[-_]?key` and `private[-_]?key`; both are kept anyway so the union is provably never narrower.

Verified over a name table:

| Name                                                                                | shipped | widened                                 |
| ----------------------------------------------------------------------------------- | ------- | --------------------------------------- |
| `KEY`, `key`, `keys`, `OPENROUTER_KEY`, `MY_KEY`                                    | false   | true                                    |
| `TOKEN`, `API_KEY`, `apikey`, `authorization`, `X-Api-Key`, `Cookie`, `private_key` | true    | true                                    |
| `monkey`, `keyboard`, `turnkey`, `donkeys`, `whiskey`, `Content-Type`, `toolName`   | false   | false                                   |
| `cacheKey`, `sortKeys`                                                              | false   | true (accepted)                         |
| `keySet`                                                                            | false   | false (accepted miss: a camel *prefix*) |

A regression sweep over every `{prefix}{shipped-alternative}{suffix}` combination found **0** names the shipped pattern masked and the widened one does not.

Measured blast radius on the key-name pass itself: across a 12 MB real review log (16 524 records), **0** of the 79 distinct structural keys and **0** `toolInputPreview` keys are newly masked.

### The command masker

```typescript
// src/logging/command-redaction.ts

/** A range of the command string to replace, and what to put there. */
interface MaskSpan {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** Mask every sensitively-named value in a bash command string. */
export function redactCommandSecrets(command: string): string;

/** Apply {@link redactCommandSecrets} to every command-bearing key in a log record. */
export function maskCommandFields<T>(details: T): T;
```

`redactCommandSecrets` obtains the warmed parser, walks the tree once collecting spans, then splices right-to-left so earlier offsets stay valid.
Three node-level rules:

1. **`variable_assignment`** — the first child is `variable_name`; when it is sensitive, the span is the value node's range, replacement `[redacted]`.
   Covers `KEY="sk-…" curl …`, `KEY=sk-…`, and `export OPENROUTER_KEY="…"` (which nests the assignment under `declaration_command`, so a plain recursive walk reaches it).
2. **`word` matching `^([A-Za-z_][A-Za-z0-9_]*)=`** — tree-sitter classifies `env MY_KEY=abc deploy`'s middle token as a plain `word`, not an assignment.
   The span starts after the `=`.
   `--foo=bar` cannot match, because the name must start with a letter or underscore.
3. **Argument node in `ARG_NODE_TYPES`** (`word`, `concatenation`, `string`, `raw_string` — reused from `src/access-intent/bash/node-text.ts`, so the argument vocabulary is spelled once) whose `resolveNodeText` value matches `^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*\S`, the name is sensitive, **and** the name is not camelCase.
   The span runs from the first `:` in the node's raw text to the node's end; the replacement is `[redacted]` plus the node's opening quote character when it has one, so the rendering stays quote-balanced for `string`, `raw_string`, and `concatenation` alike.

Rule 3's not-camelCase clause is the one non-obvious guard, and it is measured rather than defensive: an HTTP field name is hyphenated (`X-Api-Key`), never camelCase, and without the clause the only false positives in the whole corpus are two records of `grep "legalDirectionalKeys: readonly"`.

Overlapping spans are resolved outermost-wins: sort by start ascending then end descending, and drop any span contained in one already kept.
An empty span (`KEY=` with no value) is dropped.

Failure posture is **best-effort**, per the gate decision: a cold parser, a thrown parse, or a recovering parse all yield whatever spans were resolved and leave the rest as written.
The whole body is wrapped so it can never throw — `writeLine` sits under the fail-closed `tool_call` boundary, and a masker that throws would cost a log line, not just a mask.

### Call-site sketch

```typescript
// src/logging/logging.ts — prepareLogDetails
const masked = maskCommandFields(details);
const bounded =
  maxFieldWidth === undefined ? masked : capLogFieldWidths(masked, maxFieldWidth);
return redactedJsonStringify({ timestamp, extension, stream, event, ...bounded });
```

Two ordering properties are security properties, not style:

- **Masking runs before the width cap.**
  Capping first truncates a command at 1000 characters, which can cut a secret in half and can make the tail unparseable.
- **Masking applies to both streams**, unlike the cap, which is review-only.
  The debug stream is unbounded because it exists to be read in full; that is a bound, not a redaction, and redaction has never been stream-specific.

`maskCommandFields` recurses through plain objects and arrays exactly as `capValue` does, keyed on a named `COMMAND_BEARING_LOG_KEYS = new Set(["command", "executedUnit"])`.
All three of today's producers write those keys at the top level, so recursion buys nothing today.
It is chosen anyway because the writer's other two passes are both recursive, and an asymmetric third stage is what a later nested producer silently escapes.
The Tidy-First assessor argued the other way (speculative generality); the disagreement is recorded in the stage note.

### Module placement

`command-redaction.ts` goes in `logging/`, whose directory-vocabulary entry is "the JSONL writer and every bound on what it may write".
It imports `getWarmBashParser`/`TSNode` from `access-intent/bash/parser.ts` and `ARG_NODE_TYPES`/`resolveNodeText` from `access-intent/bash/node-text.ts`.
`service/bash-advisory-check.ts` is the precedent for a module outside `access-intent/` that consumes the bash parse; the reverse direction (putting a masking rule in `access-intent/`, whose charter is "what is being accessed, policy-free") would be the wrong one.

## Measurements

All taken at planning time against the author's real review log: 16 524 records, 9 054 with a `command`, **7 146 unique command strings**.
Every number below is measured, not estimated.

| Probe                                                          | Result                                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| tree-sitter `variable_assignment` nodes                        | 373 across 255 commands, 144 distinct names                                                                                      |
| …whose name is sensitive under the widened predicate           | **0**                                                                                                                            |
| The same rule as a **raw-string regex** instead of a node walk | **10** — all `key=lambda x: x[1]`, `keys=list(d.keys())` inside embedded Python, plus `sed -E 's/(_authToken=).*/\1<REDACTED>/'` |
| `word`-shaped `NAME=` tokens                                   | 125; **0** sensitive                                                                                                             |
| `-H`/`--header` words                                          | 10 across 6 commands                                                                                                             |
| Rule 3 hits (final predicate, with the not-camelCase clause)   | **3** — all genuine `"Authorization: Bearer $TOK"` / `"Authorization: token $(gh auth token)"`                                   |
| Rule 3 hits without the not-camelCase clause                   | 5 — the extra 2 are `grep "legalDirectionalKeys: readonly"`                                                                      |
| Unique commands whose logged text changes                      | **2 of 7 146**                                                                                                                   |
| `--token`/`--password`-style flags                             | 0                                                                                                                                |
| Commands with a recovering (error) parse                       | 280 = 3.9 %                                                                                                                      |
| Parse + walk cost                                              | 0.055 ms mean per command (394 ms for all 7 146); p50 length 184, p99 2 025, max 72 391                                          |

The regex-versus-node row is the load-bearing one: grammar anchoring is what drives the false-positive rate to zero, because `python3 -c "…key=lambda…"` is a `string` node and not a bash assignment.

Target vectors and controls, run through the candidate implementation:

```text
MASKED    KEY=[redacted] curl https://x
MASKED    export OPENROUTER_KEY=[redacted]
MASKED    env MY_KEY=[redacted] deploy
MASKED    curl -sS -H "Authorization:[redacted]" https://x
MASKED    curl -H"Authorization:[redacted]" https://x
MASKED    curl --header 'Authorization:[redacted]' https://x
UNCHANGED grep -r "sk-ant-oat01-abc" .
UNCHANGED python3 -c "print(sorted(d, key=lambda x: x[1]))"
UNCHANGED sort --key 2 f.txt
UNCHANGED curl -H "Content-Type: application/json" https://x
```

## Module-Level Changes

### Source

- `src/logging/log-redaction.ts` — rename `isSensitiveLogKey` → `isSensitiveName` and `SENSITIVE_KEY_PATTERN` → `SENSITIVE_NAME_PATTERN`; add `CAMEL_KEY_PATTERN`; widen the pattern as above.
  Rewrite the module doc comment, which currently states the boundary this issue falsifies ("a secret embedded in a bash command string is not [masked], because a command string has no keys").
- `src/logging/command-redaction.ts` — **new**; `redactCommandSecrets`, `maskCommandFields`, `COMMAND_BEARING_LOG_KEYS`.
- `src/logging/logging.ts` — extract `prepareLogDetails` out of `writeLine`, then add the masking stage ahead of the cap; update the stage-order comment.
- `src/access-intent/bash/parser.ts` — add `readonly endIndex: number` to `TSNode`, beside `startIndex`.

`isSensitiveLogKey` has exactly one production call site (`redactedJsonStringify`, same file) and one test importer.
A repo-wide grep for the symbol, the pattern constant, and `REDACTED_PLACEHOLDER` finds nothing else in `src/`, no `.pi/skills/` reference by symbol beyond the package SKILL's prose line, and only historical mentions in `docs/plans/0647-*.md` and `docs/retro/0647-*.md`, which describe a past change and stay as written.
`architecture.md`'s `log-redaction.ts` tree entry names the symbol and must change.

No `package.json` `exports` surface changes: `logging/` is internal.

### Tests

- `test/logging/log-redaction.test.ts` — rename the import and `describe`; extend the `test.each` name tables; add the "strictly wider than the shipped pattern" pin.
- `test/logging/command-redaction.test.ts` — **new**.
- `test/logging/logging.test.ts` — add the writer-level cases; rename `"leaves a bash command string unredacted, as documented"`, whose justification is superseded, to name the real reason (`deploy --token abc123` binds no name any rule recognizes).
- `test/presentation/tool-ask-payload.test.ts` — add the invariant pin that the ask payload's command fact is unmasked (see Invariants at risk).
- `test/access-intent/bash/parser.test.ts` — predicted **unchanged**.
  `TSNode` is an interface, `endIndex` is additive, and the file's fixtures build nodes only for `parseUnresolvedAt`/`parseUnresolvedWithin`, which read neither index.
  If any fixture is an exact object literal typed as `TSNode`, the new required member breaks it and the repair lands in that step.

### Docs

Every copy of the boundary sentence moves in one commit:

- `docs/decisions/0010-permission-log-secret-exposure.md` — a dated amendment recording that the reopen condition was met, what shipped, the corrected predicate, the measurements, and the restated boundary.
  The *Grammar-anchored bash redaction — declined for now* alternative becomes a pointer to the amendment.
  Stays `status: accepted`.
- `docs/configuration.md` — the § Log file sensitivity block around line ~1205, including the blockquote and the `deploy --token abc123` example sentence.
- `docs/troubleshooting.md` — the Threat Model limitation at line ~57 (`The review log records bash command strings unredacted.`), which is now simply false as written.
- `README.md` — the *Guessing what is sensitive* non-goal, which says redaction is "key-name-structural"; it becomes name-structural.
- `.pi/skills/package-pi-permission-system/SKILL.md` — the `## Log writes` paragraph at line ~216 and its verbatim boundary sentence.
- `docs/architecture/architecture.md` — the `logging/` directory blurb (line ~985), the `logging.ts` entry (line ~986), the `log-redaction.ts` entry (line ~988), and a new `command-redaction.ts` entry.
  No roadmap step-mark: [#920] is not a Phase 15 step.
- `docs/migration/0746-review-log-fields.md` — predicted **unchanged**.
  It is a migration note scoped to the #746 release and its sentence is a true statement about that release; editing it would rewrite history rather than fix a stale claim.

The restated boundary, to appear verbatim in each:

> A value bound to a sensitive name is masked — whether the name is a log key, a shell variable, or a request header field.
> A secret with no name bound to it, such as one typed as a `grep` pattern, is not.

## Test Impact Analysis

- **New tests the change enables.**
  `redactCommandSecrets` is a pure `string → string` function over a warmed parser, so every vector and control in the Measurements table becomes a direct unit test with no logger, filesystem, or gate in the way.
  The name predicate gains a table-driven regression pin that no previous test could express, because there was no second consumer to make the "strictly wider" property matter.
- **Tests that become redundant.**
  None.
  `logging.test.ts`'s redaction block tests the key-name pass, which is unchanged in mechanism.
- **Tests that must stay as they are.**
  `logging.test.ts`'s field-width block — especially `"masks a sensitive-keyed value whole, however long it was"` — pins the cap/redaction composition that the new stage inserts itself into.
  It must stay green without edit; if it needs editing, the stage order is wrong.
- **The `--token` case.**
  `"leaves a bash command string unredacted, as documented"` passes unchanged under the new rules, because `--token` and `abc123` are two separate `word` arguments matching none of the three rules.
  That is a rename-and-rejustify, not a behavior change — and it is the reason the rename must happen in the wiring step rather than after it.

## Invariants at risk

| Invariant                                                                                         | Constituency                             | Pinned by                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The prompt is never redacted (ADR 0010) — the approver must see the real command to decide        | The human answering the ask              | **No test today.** Add one to `test/presentation/tool-ask-payload.test.ts`: an ask built from `KEY="sk-secret" curl …` carries the unmasked command as its request fact |
| Forwarding request/response files are never redacted, so the parent can render the child's prompt | A parent session serving a forwarded ask | Untouched by this change: the masker is called only from `writeLine`, and `forwarding-io.ts` has its own write path                                                     |
| A cap is not redaction; a sensitive-keyed value is masked whole however long it was               | Anyone reading the review log            | `logging.test.ts:171` — must stay green with no edit                                                                                                                    |
| `writeLine` is the only place a log line is produced                                              | Every future write path                  | `architecture.md`'s `logging.ts` constraint line; the new stage lives there for the same reason                                                                         |
| The masker cannot break the fail-closed `tool_call` boundary                                      | The gate                                 | New test: a `redactCommandSecrets` call with the parser cold, and one whose parse throws, both return the input rather than raising                                     |

The quantitative invariant is the writer's per-line cost.
Baseline: `writeLine` does one `capLogFieldWidths` walk plus one `JSON.stringify`.
Predicted post-change: plus one tree-sitter parse and walk per command-bearing string, measured at **0.055 ms mean** over 7 146 real commands (394 ms total).
A worst-case 72 KB command is a single outlier in that corpus; the pass is bounded by the command the gate already parsed once in the same tool call.

## TDD Order

1. **`refactor(pi-permission-system): rename isSensitiveLogKey to isSensitiveName`** Tidy-First preparation.
   Renames the export and the pattern constant, updating the one production call site and `test/logging/log-redaction.test.ts`'s import, `describe`, and assertions.
   No pattern change, no new cases.
   Prepares step 3: doing the rename afterwards would mean picking "log key" from "name" call sites inside the same diff as the regex widening.
   Killing mutation: none — a pure rename has no behavior to kill; verification is `pnpm run check` plus a green suite.

2. **`refactor(pi-permission-system): name writeLine's transform stages`** Tidy-First preparation.
   Extracts the existing `capLogFieldWidths` → `redactedJsonStringify` couplet out of `writeLine`'s `try` block into a pure `prepareLogDetails(details, maxFieldWidth?)`.
   No behavior change.
   Prepares step 6, whose two ordering constraints ("before the cap", "both streams") become properties of a named function instead of three inline lines a later edit can silently reorder.
   Killing mutation: none (pure extraction); the existing field-width and redaction blocks must stay green untouched.

3. **`fix(pi-permission-system): mask a value bound to a bare or suffixed key name`** Red: `isSensitiveName("KEY")`, `("key")`, `("OPENROUTER_KEY")`, `("MY_KEY")`, `("cacheKey")`, `("sortKeys")` expected true; `("monkey")`, `("keyboard")`, `("turnkey")`, `("donkeys")`, `("whiskey")`, `("Content-Type")` expected false.
   Plus a strictly-wider pin: a table of every name the shipped pattern matched, each still masked.
   Green: the union pattern plus the case-sensitive `CAMEL_KEY_PATTERN`.
   Killing mutations, one per class: (a) drop the `(?:^|[-_])keys?(?:$|[-_])` alternative — the five bare/suffixed-`key` cases go red, the shipped-name pin stays green; (b) move `CAMEL_KEY_PATTERN`'s alternatives into the `/i` regex — `monkey` goes red, `cacheKey` stays green; (c) drop `api[-_]?keys?` — the strictly-wider pin goes red on `apikey`, and nothing else moves.

4. **`refactor(pi-permission-system): expose a node's end offset to the bash parse`** Adds `readonly endIndex: number` to `TSNode` in `src/access-intent/bash/parser.ts`.
   Folded here rather than into step 5 only if `pnpm run check` shows a `test/` fixture typed as `TSNode` that the new required member breaks — otherwise fold this one-line addition into step 5 and skip this step, noting it.
   Killing mutation: not applicable; the member is verified by step 5's spans being correct at all.

5. **`refactor(pi-permission-system): add a grammar-anchored command-secret masker`** `refactor:` and not `fix:` because nothing imports the module yet — a user observes nothing until step 6.
   Red: a new `test/logging/command-redaction.test.ts` covering, as separate `describe` blocks, (a) assignment forms, (b) the `word` assignment form, (c) the header-argument form across `word`/`string`/`raw_string`/`concatenation`, (d) the controls, (e) overlap and empty-span handling, (f) the failure posture.
   Green: `redactCommandSecrets` + `maskCommandFields`.
   Killing mutations, one per rule class: (a) make the `variable_assignment` branch mask only when the name equals `TOKEN` — the four assignment cases go red, header and word cases stay green; (b) delete the `word` branch — only `env MY_KEY=abc deploy` goes red; (c) drop the not-camelCase clause in rule 3 — the `grep "legalDirectionalKeys: readonly"` control goes red while the three `Authorization` cases stay green; (d) apply spans left-to-right instead of right-to-left — a two-span command goes red; (e) make `getWarmBashParser()` returning `null` throw instead of returning the input — the cold-parser case goes red.

6. **`fix(pi-permission-system): stop writing a named secret into the permission logs`** The observable fix; the subject names the outcome, not the seam.
   Red: new cases in `test/logging/logging.test.ts` — a review entry whose `command` is `KEY="sk-secret" curl …` is written masked; the same for `executedUnit`; the same for the **debug** stream; and a command longer than `reviewLogFieldMaxWidth` whose secret sits past the cap is still masked (the ordering pin).
   Also lands the `test/presentation/tool-ask-payload.test.ts` invariant pin from the table above, the rename of `"leaves a bash command string unredacted, as documented"`, and the rewrite of `log-redaction.ts`'s module doc comment.
   Green: `prepareLogDetails` calls `maskCommandFields` ahead of the cap, for both streams.
   Killing mutations: (a) delete the `maskCommandFields` call — every new writer case goes red and the existing field-width cases stay green; (b) move the call after `capLogFieldWidths` — only the past-the-cap ordering case goes red; (c) gate the call on `stream === "review"` — only the debug case goes red.
   Commit body carries `Refs #920` and `Co-authored-by: Radu0120` — the corrected predicate is an adopted design contribution under the repo's adoption rule, whether or not a patch was taken.

7. **`docs(pi-permission-system): restate the log-redaction boundary as name-structural`** The ADR 0010 amendment plus all five verbatim copies and the architecture entries, exactly as listed in Module-Level Changes.
   Verification: `pnpm exec rumdl check` on each touched file, and a repo-wide grep for the old sentence returning only `docs/plans/0647-*.md`, `docs/retro/0647-*.md`, and `docs/migration/0746-review-log-fields.md`.

## Risks and Mitigations

- **The masker throws and costs a log line.**
  `writeLine` already sits inside a `try`, but a throw there returns a warning string instead of a line.
  Mitigation: `redactCommandSecrets` catches everything and returns its input; step 5's killing mutation (e) pins that the cold-parser path returns rather than raises.
  This is a risk about the mechanism being **absent**, so the test exercises absence (a cold parser, a throwing parse), not the happy path.
- **A recovering parse hides an assignment.**
  3.9 % of corpus commands parse with an error.
  Accepted by the gate decision (best-effort), recorded in the ADR amendment as a named residual rather than left implicit.
  The alternative — blanking the whole field — would cost the command text on every heredoc-bearing entry, which is the main reason the log is read.
- **Over-masking a legitimate value.**
  A key named `cacheKey`, or a `grep` pattern of the form `Something-Key: value`, now reads `[redacted]`.
  Measured at 2 records in 7 146 before the not-camelCase clause and 0 after.
  ADR 0010 already accepted the same class for `token`.
- **Parse cost on a pathological command.**
  The corpus maximum is 72 KB.
  Mitigation: none beyond measurement — the same command was already parsed once by the gate in the same tool call, so the writer's parse at most doubles a cost already paid.
  If this proves wrong in practice, a length ceiling on the masker is a one-line follow-up.
- **The boundary sentence drifts between its copies.**
  Six files repeat it; one is deliberately left alone.
  Mitigation: step 7 moves all five together and verifies with a repo-wide grep whose expected residue is enumerated above.
- **A later producer nests a `command` key and escapes the pass.**
  Mitigated by making `maskCommandFields` recursive, against the Tidy-First assessor's advice; the disagreement is recorded rather than silently resolved.

## Open Questions

- Whether a non-interpolating heredoc body should be masked at all — it is data rather than shell, and the package parses it for no other reason.
  Deferred to [#923] along with inline-shell payloads.
- Whether `keySet`-shaped camel **prefixes** should match.
  Left out: the report does not ask, the corpus has none, and widening the prefix side re-admits `keyboard`-adjacent names.
  Revisit if a report shows one.

[Radu0120]: https://github.com/Radu0120
[#920]: https://github.com/gotgenes/pi-packages/issues/920
[#923]: https://github.com/gotgenes/pi-packages/issues/923
