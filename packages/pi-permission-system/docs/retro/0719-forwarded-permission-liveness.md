---
issue: 719
issue_title: "Subagent `ask` permissions stall for 10 minutes, then auto-deny without parent prompt"
---

# Retro: #719 — Subagent `ask` permissions stall for 10 minutes, then auto-deny without parent prompt

## Stage: Planning (2026-08-13T00:52:48Z)

### Session summary

Planned a third-party bug report from `akozhin-yint`: a `@gotgenes/pi-subagents` child hit an `ask` rule, no parent dialog appeared, and after exactly ten minutes the child received `User denied bash command 'pwd'`.
Traced the whole forwarding stack (`ParentAuthorizer` → file protocol → `ForwardingManager` → `ForwardedRequestServer`) and Pi's own `showExtensionCustom`, and could not determine statically why the parent failed to drain the request.
The plan therefore delivers the failure-mode half in full — truthful `confirmationUnavailable` denials, an in-process serving registry so the child abandons in seconds naming the target session id, serving-side log lines, and a `forwardingTimeoutMs` config field — and splits the unexplained stall into [#722] with the evidence gathered here.

### Observations

- **What the ten-minute wait proves.**
  `selectAuthorizer` checks `ctx.hasUI` before `isSubagent`, and an unresolved target denies immediately, so the duration alone pins the child to the `ParentAuthorizer` path with a resolved target and a written request file.
  `ForwardedRequestServer.resolveDecision` catches escalation errors and writes a denial promptly, so the parent never reached it — `processInbox` returned early.
  That narrows the cause to a stopped timer or a session-id mismatch without needing the reporter's logs.
- **A hypothesis worth killing early.**
  I spent real effort on "the TUI cannot mount `ui.custom` while the parent is idle at the editor prompt", which fit the `run_in_background: true` detail and explained why #710's reporter saw prompts render.
  An `Explore` subagent on the sibling `../pi` checkout refuted it in 80 seconds: `showExtensionCustom` (`interactive-mode.ts:2659`) has no turn-state gating and stdin is read non-blockingly, so timers fire while idle.
  Cheap refutation of a plausible-but-wrong theory was the highest-value tool call of the session.
- **The root cause is not the deliverable.**
  The operator chose "observability + truthful failure + fast-fail liveness" over a diagnose-first plan.
  That is the right call here: the misleading `User denied` message is a definite defect regardless of cause, and the serving-side log line the plan adds is precisely the instrument that makes the next report diagnosable in one diff.
- **The fix was mostly already in the codebase.**
  `PermissionPromptDecision.confirmationUnavailable` already flips the block message to `buildUnavailableBody` and the review-log resolution to `confirmation_unavailable`.
  `DenyingAuthorizer` sets it; `ParentAuthorizer` never does.
  Most of the "truthful abandonment" work is setting an existing flag, not building a mechanism.
- **One asymmetry blocks the reason from reaching the model.**
  `applyPermissionGate` takes `userDeniedReason` as `(decision) => string` but `unavailableReason` as a precomputed `string`, so a `denialReason` on an unavailable decision is silently dropped.
  Removing the asymmetry is a better framing than adding a field.
- **Provenance over re-derivation.**
  The fast-fail must not fire for out-of-process children, and `resolvePermissionForwardingTargetSessionId` already knows whether it resolved via the in-process registry or env vars — then throws that away.
  Returning a `{ sessionId, source }` product beats re-deriving "in-process" inside `ParentAuthorizer`, which would leave two places that must agree.
  Landed as a Tidy First `refactor:` step so the feature steps stay small.
- **Injecting the timeout unlocks coverage.**
  `getTimeoutMs` is nominally about the new config field, but its real payoff is that `ParentAuthorizer`'s timeout branch becomes unit-testable.
  Today a test covering it would run for ten minutes, which is why `test/composition-root.test.ts` had to build a fire-without-await round trip in the first place.
- **Rejected alternatives.**
  A filesystem claim artifact and a serving heartbeat both cover out-of-process children but carry a version-skew hazard (an older serving node never claims, so a newer child fast-fails on a parent that is about to prompt).
  The process-global registry has no skew hazard because an in-process child is by construction the same install.
  Both filesystem options are parked in [#721].
- **Scope note.**
  The issue carries both `pkg:` labels, but no `pi-subagents` code changes — its side of the contract (`subagents:child:session-created` carrying `parentSessionId`) is already correct.
  Filed as a single-package plan under `packages/pi-permission-system/docs/plans/`.
- **Version skew in the report.**
  The reporter is on `pi-permission-system@22.0.0` against a current `25.0.0`.
  I read the intervening changelogs; nothing between them touches forwarding, so the bug is expected to reproduce on current versions.

## Stage: Implementation — TDD (2026-08-13T04:01:54Z)

### Session summary

Landed ten commits: two preparatory refactorings from the plan, one preparatory test fixture from the Tidy-First assessor, five behavior commits, and a docs commit.
The `pi-permission-system` suite grew from 2721 to 2757 tests (+36) across 131 → 132 files.
All deterministic gates green throughout: `check`, root `lint` (0 findings), full workspace `test`, and `fallow dead-code`.

### Observations

- **Pre-completion reviewer: PASS** — ready for `/ship-issue`.
- **Reviewer warnings** — the four new liveness tests run against real timers and the 2000 ms grace window, costing ~2.0–2.5 s wall clock each (measured 2011/2262/2518/2236 ms).
  None raced across repeated local runs and all sit well inside vitest's 5000 ms default, but they are the tests most exposed to a slow CI runner.
  The reviewer suggests `vi.useFakeTimers()` as a follow-up tidy pass only if CI margin becomes a problem; deliberately not done here, since converting them late would trade a measured-safe margin for a fresh flakiness risk.
- **Deviation: the timeout seam moved a step earlier.**
  The plan put `getTimeoutMs` in step 8 with the config field, but step 6 needs it: the poll-timeout abandonment path is otherwise a literal ten-minute test.
  Splitting the seam (step 6) from the operator-facing config key (step 8) is the better split anyway.
- **Deviation: the Tidy-First `abandon()` extraction was folded in, not landed separately.**
  The assessor was right that five hand-edited abandonment sites is the friction, but every honest version of the extraction also changes the returned decision shape — a "behavior-preserving" preparatory commit would have needed a helper name that lied about the current behavior.
  Folding it into step 6 gave the same result: all six paths now route through one `abandon()` helper, so no future path can omit the marker.
  The assessor's other recommendation (`makeParentAuthorizerDeps`) was genuinely preparatory and landed as its own `test:` commit — it absorbed both new deps in one place instead of six.
- **Deviation: `config-loader.ts` was missing from the plan's file table.**
  The plan attributed the scalar merge loop to `extension-config.ts`'s `mergeUnifiedConfigs()`; that function actually lives in `config-loader.ts`.
  A field added to the runtime type but not that loop is silently dropped before runtime — the failure class the package skill already warns about — so the omission would have been caught by the merge test regardless, but the plan's grep should have located the function rather than trusting the skill's prose.
- **The composition-root round trip was quietly depending on nobody watching.**
  It hand-writes the parent's response instead of running the poll timer, so once the fast-fail landed it was racing the 2 s grace window rather than asserting anything.
  Fixing it with an explicit `markServing(parentSessionId)` made the test state what it had been assuming, and the paired new test (no `markServing`) is the closest thing in the suite to the reported bug.
- **Strengthening assertions surfaced the point of the change.**
  Converting the target-resolution tests from `toBe("parent-x")` to `toEqual({ sessionId, source })` was mechanical, but it is what makes the `registry`-vs-`env` distinction — the whole reason out-of-process children are never fast-failed — visible in the test names rather than buried in a branch.
- **`toMatchObject` will not assert a key's absence.**
  `confirmationUnavailable: undefined` in a `toMatchObject` expectation fails rather than passing on a missing key, so the "a real parent denial is not marked unavailable" discrimination lives in the abandonment tests' `toEqual` assertions instead.
- **One test earns its complexity.**
  Forcing the request-write failure needs a `chmod 0o500` on the requests directory, and the `finally` had to become conditional because the new cleanup removes that directory on the way out — which is itself the assertion that abandonment cleans up after itself.

## Stage: Final Retrospective (2026-08-13T04:29:53Z)

### Session summary

One continuous session carried #719 from a third-party bug report through planning, twelve commits of TDD, and a clean ship to `@gotgenes/pi-permission-system@25.1.0`.
The shipped change makes a subagent whose parent is not draining its forwarded-permission inbox abandon in ~2 s with a truthful reason, instead of stalling ten minutes and reporting a `User denied` message about a user who was never asked.
The unexplained stall itself was deliberately split into [#722] rather than chased to a conclusion the code could not support.

### Observations

#### What went well

- **Model allocation tracked task shape without being asked.**
  Planning and TDD ran on `claude-opus-5` (judgment-heavy: hypothesis elimination, design trade-offs, test design); the ship sequence ran on `claude-sonnet-5` (deterministic, tool-driven) for 29 turns with zero corrections; the retro returned to `claude-opus-5`.
  This is the allocation the model-performance lens looks for, arrived at by the operator mid-session.
- **The `pre-completion-reviewer` measured instead of estimating.**
  Asked whether the grace-window timing made the new tests flaky, it timed all four (2011 / 2262 / 2518 / 2236 ms) and framed the WARN against vitest's 5000 ms default rather than asserting a risk.
  That is exactly the measured-vs-estimated discipline `AGENTS.md` asks of numbers, applied by a subagent unprompted.
- **A Tidy-First recommendation was rejected with an argued reason.**
  The assessor's `abandon()` extraction was right about the friction (five hand-edited abandonment sites) but not landable as a preparatory commit: every honest version also changes the returned decision shape, so the "behavior-preserving" commit would have needed a helper name that lied.
  Folding it into the behavior step reached the same end state — all six paths route through one helper — and the `tidy-first` skill's "the report is advisory; you decide what lands" contract got its first real exercise.
- **Caught a green test that had stopped asserting.**
  `test/composition-root.test.ts`'s forwarding round trip hand-writes the parent's response instead of running the poll timer, so once the fast-fail landed it was passing only because `approveForwardedRequest` beat the 2 s grace window.
  Making the assumption explicit (`markServing(parentSessionId)`) removed a latent flake the suite would not have reported until CI was slow.
- **Splitting the deliverable from the diagnosis held up under review.**
  The reviewer independently confirmed both plan-named follow-ups ([#721], [#722]) carried recorded issue numbers, and the shipped change stands on its own without the root cause.

#### What caused friction (agent side)

- `rabbit-hole` — the root-cause hunt ran inline instead of being delegated.
  Roughly 30 tool calls across ~20 turns read the whole forwarding stack (`approval-escalator`, `forwarded-request-server`, `forwarding-manager`, `permission-forwarding`, `permission-session`, `lifecycle`, `before-agent-start`, `subagent-detection`, `subagent-context`, `extension-paths`, plus `pi-subagents`' `runtime.ts` and `create-subagent-session.ts`), forming and discarding six hypotheses: the child's `ForwardingManager` stopping the parent's timer, a child `hasUI: true` self-targeting its own inbox, `SUBAGENT_ENV_HINT_KEYS` misclassifying the parent, an unhandled rejection looping `processInbox`, a session-id mismatch, and `ui.custom` being gated while the parent sits idle.
  Only the last was delegated — an `Explore` subagent on `../pi` refuted it in 80 s.
  Impact: no rework and the conclusion was correct ("not determinable from the code"), but it consumed a large share of the planning session's context immediately before the plan had to be written.
- `instruction-violation` (self-identified) — an `Edit` `oldText` anchored on the decorative `// ── Mocks ──…` rule in `test/authority/forwarding-manager.test.ts`, which `AGENTS.md` explicitly says to avoid in favour of adjacent unique code lines.
  Impact: one rejected atomic batch, one extra `Read`.
- `instruction-violation` (self-identified) — an `Edit` `oldText` for `test/authority/serving-registry.test.ts` built from the layout I had just emitted, after `pi-autoformat` reflowed the `delete store[KEY]` statement across three lines.
  `AGENTS.md` states the rule directly: re-read a region you just edited before editing it again.
  Impact: one rejected batch, one extra `Read`.
- `missing-context` — wrote `delete store[SERVING_SESSION_REGISTRY_KEY]` in the new test file without checking how `test/composition-root.test.ts` already performs the identical process-global-`Symbol` teardown (it carries an `eslint-disable @typescript-eslint/no-dynamic-delete`).
  Impact: one commit blocked by the `prek` hook, one grep, one edit, one re-commit — the gate working as designed.
- `missing-context` — the plan's Module-Level Changes table attributed `mergeUnifiedConfigs()` to `extension-config.ts` because the package skill's "adding a field" bullet names it in the same sentence as that file; it actually lives in `config-loader.ts`.
  Impact: two files touched that the plan did not list, recorded as a deviation.
  No rework — a genuinely dropped field would have failed the merge test.

#### What caused friction (user side)

- The `ask_user` gate worked in a single round: direction, liveness mechanism, and timeout policy were all decided in one call, and the answers drove the plan's Goals directly.
  No friction to report there.
- One opportunity, framed as such: the reporter's `forwarded_permission.*` review-log lines would have collapsed the ~30-call hunt into a lookup.
  For a third-party bug that does not reproduce, asking for the review log in the issue thread *before* `/plan-issue` runs would put the decisive evidence in the planning session's hands instead of leaving it to inference.

### Diagnostic details

- **Model-performance correlation** — no mismatch found.
  Turn-level attribution: `claude-opus-5` for planning + TDD, `claude-sonnet-5` for the entire ship sequence, `claude-opus-5` for the retro.
  Subagents: `Explore` on `model: "sonnet-5"` for the `../pi` `ui.custom` trace (the model `AGENTS.md` prescribes for that checkout, since `Explore`'s haiku default is too weak); `tidy-first-assessor` and `pre-completion-reviewer` on their configured defaults, both judgment-heavy and both delivering substantive reports (27 and 46 tool uses).
- **Escalation-delay tracking** — the single `rabbit-hole` ran ~30 consecutive tool calls on one question before the strategy changed, six times the lens's five-call threshold.
  The delegation that did happen (the `Explore` dispatch) proved the mechanism: 80 s to kill a hypothesis that had already absorbed several turns.
- **Unused-tool detection** — an `Explore` or `general-purpose` subagent was available for the main hunt and used only for a sub-question.
  `colgrep` was never dispatched this session; every search was for an exact symbol, where `grep` is the right tool per the `colgrep` skill's decision table, so that is not a gap.
- **Feedback-loop gap analysis** — no gap.
  `pnpm run check` plus the affected test file ran after every Red and every Green; the full package suite ran before every commit; root `pnpm run lint` and `pnpm fallow dead-code` ran at the green baseline, before the docs commit, and again as pre-push checks.
  The two type errors introduced by widening `AuthorizerSelectionDeps` surfaced on the `check` immediately after that step rather than at end-of-cycle.

### Changes made

1. `.pi/prompts/plan-issue.md` — added "Gather context" step 6: dispatch `Explore` (`model: "sonnet-5"`) for the root-cause hunt when a bug report does not reproduce locally.
   Generalizes the `../pi` "hunt vs. targeted read" economics already in `AGENTS.md` to our own packages.
   Renumbered the following two steps and updated the "Write the plan" back-reference from "Gather context step 7" to "step 8".
2. `.pi/skills/testing/SKILL.md` — added a "Test assertions" bullet recording that `toMatchObject` does not assert a key's absence (an expected `undefined` requires the key to be present).
   Verified against this repo's Vitest 4 with a throwaway probe before landing.
3. `.pi/skills/package-pi-permission-system/SKILL.md` — attributed `mergeUnifiedConfigs()` to `config-loader.ts` in the "adding a field" checklist, and named its "Number scalars" loop.
   The unattributed symbol sat in a sentence where every other symbol carried its filename, which is what misled this issue's plan table.

Deliberately not landed: no new text for the two `Edit` `oldText` failures (`AGENTS.md` already states both rules — these were salience misses), nothing for the `no-dynamic-delete` miss (the `prek` hook caught it in one cycle), and no `vi.useFakeTimers()` rule (the reviewer measured the margin as safe and scoped a fix to "only if CI degrades").

[#721]: https://github.com/gotgenes/pi-packages/issues/721
[#722]: https://github.com/gotgenes/pi-packages/issues/722
