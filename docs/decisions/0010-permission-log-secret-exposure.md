---
status: accepted
date: 2026-07-25
---

# 0010 — Permission logs are mode-restricted and key-name redacted, not secret-detected

## Status

Accepted, as amended 2026-09-15.
This decision states what the permission logs protect against and what they do not, so a report of the shape "the log contains a secret" can be triaged against a written contract rather than re-argued.

### Amendment, 2026-09-15 — the reopen condition was met, and the nominated remedy was wrong

The *Grammar-anchored bash redaction* alternative below recorded itself as "the concrete next step should a report show a secret reaching the log through a command string".
[#920] is that report: measured on a real install with `permissionReviewLog: true`, 35 records held a live API key verbatim in the `command` field — 19 through a `KEY="<secret>"` env-prefix assignment, 8 through `curl … -H "Authorization: Bearer <secret>"`, 2 through a `grep` pattern, 6 through other forms.

The report also **corrects** the remedy this record nominated, which is the more useful half.
The nominated rule masks the value of an assignment whose name is sensitive; the name actually used was `KEY`, and the shipped predicate carried `api[-_]?key` and `private[-_]?key` but no bare or suffixed `key`.
So all 19 assignment leaks would have been written unredacted even after the nominated rule landed.
The correction is adopted with credit.

What shipped:

- The sensitive-name predicate gained a name-boundary `key` rule (`KEY`, `OPENROUTER_KEY`, `MY_KEY`, `apiKey`, `sortKeys`), as a **union** with the pattern it replaces, so it adds names and drops none.
  `monkey`, `keyboard`, and `turnkey` do not match.
- `command-redaction.ts` masks a value bound to a sensitive name **inside** a command string, in three binding forms: a `variable_assignment` value, a `word`-shaped assignment (`env MY_KEY=abc deploy`), and an argument of the form `<sensitive-name>: <value>` (the header vector).
  Every rule matches a parse node, never a substring.
- The pass runs at `writeLine`, ahead of the width cap and for both streams.

The technique is unchanged: **structural, never predictive**.
What changed is that a name can now be a shell variable or a request header field, not only a log key.
Grammar anchoring is what makes that affordable, and the measurement is the argument: over 7 146 unique commands from a 12 MB review log, a raw-string scan for a sensitively-named assignment matched 10 commands and every one was a false positive — `key=lambda x: x[1]` and `keys=list(d.keys())` inside embedded Python, plus a `sed` pattern that was itself a redaction.
The node-anchored rule matched none of them.
The header rule additionally requires the field name not to be camel-cased, because an HTTP field name is hyphenated (`X-Api-Key`) and without that clause the corpus's only false positives were two records of `grep "legalDirectionalKeys: readonly"`.
Across the whole corpus, 2 of 7 146 commands log differently than before.

Three residuals are accepted rather than hidden:

- A secret with **no name bound to it** — the report's 2 `grep`-pattern records — is out of reach of any structural rule and stays unmasked.
  That is the surviving half of the boundary below, not an oversight.
- A **recovering parse** (3.9 % of corpus commands) yields whatever spans the walk resolved and leaves the rest as written.
  Blanking the field instead would cost the command text on every heredoc-bearing entry, which is the main reason this log is read.
- An **inline-shell payload** (`bash -c 'TOKEN=… deploy'`) and a **heredoc body** carry no assignment node, so neither is masked — and `executedUnit` re-parses to a real assignment, so one record can hold the same secret masked under one key and unmasked under another.
  Widening to them needs the wrapper analyzer, because blanket recursion into string nodes is exactly what re-admits the false-positive class above.
  Tracked as [#923].

The report's second observation — that `chmod` is a no-op on Windows, so neither remedy was active there — is answered by this change rather than by a new mechanism: redaction does not depend on file modes.
The reasoning against a per-session Windows warning, below, is unchanged.

## Context

The permission review log is enabled by default and records every gate decision.
Two of its fields carry payload rather than metadata: `command`, the complete bash command string, and `toolInputPreview`, a serialized JSON preview of a non-bash tool's input bounded at 1000 characters.
The debug stream carries the same payload again when `debugLog` is on.

[#647], a third-party report, observed that these values are persisted without redaction and that the files are appended without an explicit mode, so their permissions follow the process umask.
Both observations were accurate.
Measured on the reporter-equivalent installation, the review log was 6.7 MB across 8380 lines with mode 0644 — world-readable — and the logs directory 0755.

The report proposed two remedies: redact common secret forms before persistence, and create the files owner-only.
These address different adversaries, and conflating them is what makes the issue recur.

| Adversary                                    | Closed by owner-only modes                                                                                                                                    | Closed by redaction                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Another local user on a shared host          | Yes, completely                                                                                                                                               | Redundant                                                     |
| A backup or cloud-sync agent copying `~/.pi` | No — it runs as the user                                                                                                                                      | Yes                                                           |
| The user pasting a log excerpt into an issue | No                                                                                                                                                            | Partially                                                     |
| The agent reading its own log                | Already closed — the logs directory is outside the session cwd, so the `external_directory` gate prompts, and `isPiInfrastructureRead` does not auto-allow it | Only relevant where the operator has allowed `~/.pi/**` reads |

## Decision

### Owner-only modes, unconditionally

Both JSONL logs are created `0600` and the logs directory `0700`; permission-forwarding request and response files and their directories likewise.
Because a `mode` option applies only when the call creates the path, each log is additionally `chmod`-ed once per session on first write — an installation predating this change would otherwise keep its world-readable log indefinitely.

`mkdirSync`'s `recursive` mode applies to every directory it creates, so a fresh install also gets an owner-only extension config directory.
Directories that already exist are never modified, so an operator's chosen layout above the logs directory is untouched.

### Key-name redaction, not value-shape detection

A value bound to a key named `authorization`, `token`, `secret`, `password`, `passwd`, `credential`, `cookie`, `api_key`, or `private_key` (case-insensitive, separator-tolerant) is masked with `[redacted]` before serialization.

The technique is deliberately **structural rather than predictive**: a value is masked because of the name it is bound to, never because of what it looks like.

This is applied at two points, and the second is not redundant:

1. `writeLine` in `src/logging/logging.ts` — the single point where either stream reaches disk, covering any call site that logs a nested object.
2. `serializeRedactedToolInputPreview`, reached from `formatGenericToolInputForLog` — because `getToolInputPreviewForLog` flattens the tool input to a string *before* the details record reaches the writer, so by point 1 its keys no longer exist to match.

Point 2 is what closes the reporter's literal repro.

### The prompt is never redacted

`formatToolInputForPrompt` and the forwarding request/response files stay unredacted.
The user must see the real input to make a permission decision, and the forwarding files exist so the parent can render that prompt.
Masking either would blind the approver — a permission regression dressed as a security fix.

## Alternatives considered

### Value-shape secret detection — declined

A provider-prefix list (`sk-`, `ghp_`, `AKIA`, `xox`, `Bearer`, PEM markers) or an entropy heuristic.

Declined on measured evidence.
Probing the live 6.7 MB review log for exactly those shapes:

| Probe                                                        | Hits | What they were                                                                                                                                                                           |
| ------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sk-`                                                        | 403  | 356 the tail of `task-approval`, 275 of `task-user`, 146 of `task-no-ui` — all substrings of `task-*`. The 4 genuine `sk-ant-oat…` shapes sat inside a grep pattern the agent had typed. |
| `xox`                                                        | 2    | Inside the tool-use id `toolu_01VdGtvuHfmxox86kCCkY3`.                                                                                                                                   |
| `API_KEY`                                                    | 8    | The literal env-var **name** `ANTHROPIC_API_KEY`; no value.                                                                                                                              |
| `Bearer `, `ghp_`, `github_pat_`, `AKIA`, `AIza`, `password` | 0    | —                                                                                                                                                                                        |

Anchoring the patterns would fix those particular false positives, but the corpus contained **zero true positives**, so the list would be pure maintenance burden.
More decisively, its failure boundary is unstatable: a redactor that silently misses a key is worse than a documented warning, because it invites treating the log as safe to share.

This is the same reasoning already recorded for [#599] and `docs/decisions/0007-model-judge-authorizer-chain-adr.md`, where a hard-coded secret denylist was declined because the codebase has no formal secrets model.
Secret *detection* is a product category (gitleaks, trufflehog, detect-secrets) with hundreds of continuously-maintained rules; the logging ecosystem's own answer — pino's `redact`, Winston's formats, Serilog's destructuring policies — is uniformly declarative key-path masking, not detection.

### Grammar-anchored bash redaction — declined here, adopted by the 2026-09-15 amendment

The package already parses every bash command into a tree-sitter AST and already walks `variable_assignment` nodes to strip env prefixes ([#481]) and embedded option values ([#645]).
Masking the value side of an assignment whose name is sensitive, and the argument following `--token`/`--password`, would extend coverage to `FOO_TOKEN=abc deploy` with near-zero false positives, because it operates on parse nodes rather than on a guess about what a string looks like.

Not taken here: it is materially more work than the key-name pass, and no reported case yet demands it.
It is recorded as the concrete next step should a report show a secret reaching the log through a command string.

[#920] is that report, and the amendment above records what shipped — including the respect in which the rule sketched here would not have caught the reported case.

### Making raw payload logging opt-in — declined

Flipping `permissionReviewLog` to `false`, or gating `command`/`toolInputPreview` behind a new `logToolInput` flag.

Declined as a breaking change that trades away the package's stated priority that block/ask/allow decisions stay reviewable by default.
`matchedPattern` without `command` makes "what exactly did the agent run at 14:32" unanswerable, which is the main reason to read this log.

### A downstream redactor registry — declined

A `PermissionsService.registerLogRedactor(name, redact)` mirroring `ToolInputFormatterRegistry` / `ToolAccessExtractorRegistry` / `AuthorizerRegistry`.

Structurally cheap and low-novelty, but it would ship with zero consumers, which is precisely the maintenance trap the package's own guidance warns against.
Revisit if a concrete downstream asks.

## Consequences

- The stated boundary, which every user-facing mention repeats verbatim, as amended 2026-09-15: **a value bound to a sensitive name is masked — whether the name is a log key, a shell variable, or a request header field.**
  **A secret with no name bound to it, such as one typed as a `grep` pattern, is not.**
- A key legitimately named `token` carrying a non-secret now reads `[redacted]` in the log.
  Accepted: the key set is narrow, and every structured field the gate logs (`toolName`, `action`, `reason`, `matchedPattern`, `origin`, `resolution`) falls outside it.
- The change is POSIX-effective only.
  On Windows `chmod` toggles only the read-only bit and the `mode` options are ignored, so the files there are governed by NTFS ACL inheritance.
  The `chmod` failure is swallowed rather than warned about, because a warning every session on Windows would be noise.
- A custom formatter registered through `ToolInputFormatterRegistry` returns an opaque string for a path-bearing tool, which this change cannot mask.
  A registrant emitting credentials into a log preview is responsible for its own output.
- Because a hardening failure never throws, no new failure mode reaches the fail-closed tool-call boundary.

[#481]: https://github.com/gotgenes/pi-packages/issues/481
[#599]: https://github.com/gotgenes/pi-packages/issues/599
[#645]: https://github.com/gotgenes/pi-packages/issues/645
[#647]: https://github.com/gotgenes/pi-packages/issues/647
[#920]: https://github.com/gotgenes/pi-packages/issues/920
[#923]: https://github.com/gotgenes/pi-packages/issues/923
