---
issue: 712
issue_title: "pi-permission-system: yolo mode prompts for wrapper-floored and unparseable bash asks"
---

# Honor yolo for residual synthetic bash asks

## Release Recommendation

**Release:** ship independently

Issue #712 is not a numbered step in the `docs/architecture/architecture.md` roadmap and carries no `Release:` batch tag, so it ships on its own.
It lands as a `fix:` commit pair, which cuts a release at the next release-please merge.

## Problem Statement

`yoloMode: true` is meant to suppress every `ask` prompt.
It is implemented as a composition-stage rewrite: `rewriteAsksToYolo` turns every `ask` rule in the composed ruleset into an `allow` tagged `origin: "yolo"` ([#526]), and `GateRunner` fast-paths `state === "allow" && origin === "yolo"` into a single `auto_approved` review entry without prompting.

Two bash asks are synthesized **after** the resolver returns — at the result level, outside the ruleset — so the rewrite never sees them:

1. The wrapper floor in `resolveBashCommandCheck` (`src/handlers/gates/bash-command.ts`) clamps a resolved `allow` up to `{ ...base, state: "ask", matchedPattern: WRAPPER_SENTINEL[kind] }` for an opaque-payload ([#481]) or indirection ([#490], [#575]) wrapper.
2. The fail-closed branch of the same function synthesizes `{ state: "ask", matchedPattern: "<unparseable-bash-command>" }` for a non-empty command that parses to zero command units ([#452]).

Both reach `GateRunner` with `state: "ask"`, miss the `state === "allow"` fast path, and prompt.

Measured at planning time against the real extension (composition-root harness, `makeFakePi` + the real factory, a UI ctx capturing `ui.select` titles):

| Config                                   | Command                        | Observed today                                   |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `yoloMode: true`, `bash: {"*": "ask"}`   | `git status \| xargs grep foo` | prompts — `matched '<indirection-bash-wrapper>'` |
| `yoloMode: true`, `bash: {"*": "allow"}` | `git status \| xargs grep foo` | prompts — same sentinel                          |
| `yoloMode: true`, `bash: {"*": "ask"}`   | `git status \| grep foo`       | no prompt (the rewrite works)                    |
| `yoloMode: true`, `bash: {"*": "allow"}` | `> out.txt` / `2>&1`           | prompts — `matched '<unparseable-bash-command>'` |
| `yoloMode: false`, `bash: {"*": "deny"}` | `> out.txt`                    | prompts, and the prompt is approvable            |

The last row is a second defect found while tracing, independent of yolo: the unparseable branch synthesizes its `ask` **without consulting the resolver at all**, so an explicit `bash` `deny` is silently downgraded to a prompt the user can approve.
It must be fixed before yolo may auto-approve a residual ask, or yolo would turn that masked `deny` into a silent grant.

## Goals

- Under `yoloMode: true`, a wrapper-floored or unparseable bash `ask` is auto-approved without prompting, recorded exactly as today's yolo grant (`permission_request.auto_approved` + a decision event with `resolution: "auto_approved"`).
- An explicit `deny` still blocks under yolo — including for an unparseable command, which today prompts instead of denying.
- The reconciliation lives at the gate's single choke point, so the `PermissionPrompter` contract ("an `ask` never reaches this class under yolo") holds structurally for every synthesized ask, not only the two bash ones.
- The docs that assert the (currently false) contract are corrected: `docs/architecture/architecture.md` § "yolo is recorded authority", `docs/architecture/permission-prompter.md`, `docs/configuration.md` § "Fail-closed behavior", and the package skill.

Not a breaking change: `yoloMode` defaults to `false`, and with yolo off every decision is byte-identical to today except that an unparseable command matching an explicit `deny` now blocks instead of prompting — a tightening of a deny-masking hole, not a loosened default.

## Non-Goals

- Configurable exemptions from the indirection-wrapper floor ([#680]) — unchanged; the floor still applies with yolo off.
- Inspecting or unwrapping the inner command of a wrapper ([#706], [#713]) — unchanged.
- Yolo parity on the **advisory** path (`resolveBashAdvisoryCheck`, `src/bash-advisory-check.ts`, [#309]).
  It answers through the same `resolveBashCommandCheck`, so under yolo it will report `ask` for a wrapper the gate now allows.
  That direction is safe (the advisory answer stays *stricter* than the gate, never weaker), and the reconciliation is a gate concern; see Open Questions.
- Any change to `rewriteAsksToYolo`, the fail-closed `allow`→`ask` floor ([#646]), or the composition-stage overlay order.
- A `--yolo` launcher flag ([#720]) or the yolo override PR — orthogonal wiring of the same config field.

## Background

Relevant modules:

- `src/rule.ts` — `rewriteAsksToYolo(rules)`: the composition-stage overlay, `origin: "yolo"`.
- `src/permission-manager.ts` — `check()` applies the rewrite post-cache when the injected `isYoloEnabled()` reader reports true; `index.ts` supplies `() => isYoloModeEnabled(configStore.current())`, read per check so a mid-session toggle takes effect.
- `src/handlers/gates/bash-command.ts` — `resolveBashCommandCheck`: per-unit resolve, wrapper floor, unparseable fail-closed, `pickMostRestrictive`.
- `src/handlers/gates/runner.ts` — `GateRunner.runDescriptor`: resolve → session fast path → yolo fast path (step 2b) → `applyPermissionGate` (prompt) → decision event → session-approval record.
- `src/handlers/gates/helpers.ts` — `buildDecisionEvent`, `deriveResolution` (already maps `state: "ask"` + `autoApproved` → `"auto_approved"`).
- `src/authority/authorizer-selection.ts` — `AskEscalator.escalate`, the seam past the gate; `selectAuthorizer` has no yolo knowledge and gains none here.

Constraints that apply:

- The architecture doc's § "yolo is recorded authority" states "the decision path loses all yolo knowledge".
  The two floors are per-parse, not per-pattern, so they cannot be expressed as rules — some yolo read outside the ruleset is unavoidable.
  The doc claim must be amended rather than worked around; the amendment is bounded ("the ruleset overlay is the whole story except for post-resolution floors, which the gate reconciles at one place").
- `AGENTS.md` § Clarification gates and the third-party-issue rule: #712 was filed by `maertayn`, not the operator, and re-files [#570] (closed NOT_PLANNED because a rogue agent opened it).
  The direction and placement were confirmed via `ask_user` before planning: fix it, at the `GateRunner` choke point, with the unparseable deny consult folded into this plan.
- Package skill: least privilege — the change adds auto-approval only behind an explicit `yoloMode: true` opt-in, and never over an explicit `deny`.

Blast radius of a runner-level catch-all beyond bash, enumerated from every `check` source in `runDescriptor`:

- `descriptor.preCheck` — `path`, `external-directory`, `bash-path`, `bash-external-directory`, and the tool gate all derive it from `ScopedPermissionResolver.resolve`, i.e. already yolo-rewritten; a residual `ask` there is impossible.
- `this.resolver.resolve(...)` — same.
- `descriptor.preResolved` — only `describeSkillReadGate`, whose state comes from a `SkillPromptEntry` resolved (and cached) at prompt-sanitization time.
  Under yolo it is already `allow`; it can be a stale `ask` only if yolo is switched **on** mid-session after sanitization, in which case auto-approving it is the correct yolo behavior.
- The synthesized `evaluate()` fallback (`origin: "builtin"`, `ask`) cannot surface: `synthesizeDefaults` always contributes a `*`/`*` rule, so a lookup always matches a real rule.

So the catch-all changes behavior today for exactly the two bash sentinels, and structurally covers whatever floor is added next.

## Design Overview

### 1. Deny-preserving unparseable branch

`resolveBashCommandCheck`'s zero-units, non-empty branch consults the resolver on the whole command **before** synthesizing:

```typescript
const whole = resolver.resolve({
  kind: "tool",
  surface: "bash",
  input: { command },
  agentName,
});
if (whole.state === "deny") {
  return whole;
}
return {
  state: "ask",
  toolName: "bash",
  source: "bash",
  origin: "builtin",
  command,
  matchedPattern: "<unparseable-bash-command>",
};
```

An explicit `deny` (whole-string match) wins; everything else still fails closed to the sentinel `ask`, so [#452]'s invariant — a permissive top-level `*` never silently allows an unparseable command — is untouched.
The resolver already returns `command` in the result extras for the `bash` surface, so the deny result carries the offending command for the prompt/log without extra shaping.

### 2. Residual-ask yolo grant at the gate

A pure helper next to the other gate-result derivations in `src/handlers/gates/helpers.ts`:

```typescript
export function resolveYoloGrant(
  check: PermissionCheckResult,
  yoloEnabled: boolean,
): PermissionCheckResult | null {
  if (check.state === "allow" && check.origin === "yolo") return check;
  if (check.state === "ask" && yoloEnabled)
    return { ...check, state: "allow", origin: "yolo" };
  return null;
}
```

The first arm is today's fast path, verbatim, so the [#526] review-log parity holds byte-for-byte when the ruleset already granted.
The second arm re-permits a post-resolution floor, preserving `matchedPattern` (the sentinel — the review log still shows *why* it was floored) and stamping `origin: "yolo"` (*why* it was auto-approved).
A `deny` never matches either arm, so an explicit deny is structurally out of reach.

`GateRunner` consumes it at the existing step 2b:

```typescript
const grant = resolveYoloGrant(check, this.isYoloEnabled());
if (grant) {
  this.reporter.writeReviewLog("permission_request.auto_approved", {
    ...descriptor.logContext, agentName, resolution: "auto_approved",
  });
  this.reporter.emitDecision(
    buildDecisionEvent(descriptor.decision, grant, agentName, "allow",
      deriveResolution(grant.state, "allow", false, false, true)),
  );
  return { action: "allow" };
}
```

`deriveResolution("allow", "allow", …, true)` returns `"auto_approved"` for both arms, so the emitted resolution is unchanged for the existing case.

### 3. Wiring

`GateRunner` gains a fifth constructor dependency, `isYoloEnabled: () => boolean`, read per `run` so a mid-session `/permission-system` toggle takes effect — the same closure shape `PermissionManager` already receives.
`index.ts` hoists the expression it already builds inline for the manager and passes the one reader to both:

```typescript
const isYoloEnabled = (): boolean => isYoloModeEnabled(configStore.current());
const permissionManager = new PermissionManager({ agentDir, flavor: hostFlavor, isYoloEnabled });
// …
const gateRunner = new GateRunner(resolver, sessionRules, authorizerSelection, reporter, isYoloEnabled);
```

Design-review notes (checklist run before finalizing):

- **Dependency width** — `GateRunner` goes from four to five constructor parameters.
  Four are role collaborators; the fifth is a live config read, not an object to reach through, and there is no intermediary relaying it (`index.ts` constructs the runner directly).
  The alternative — a `YoloOverlay` collaborator wrapping one predicate — buys an interface and no behavior; declined, with the width noted as track-and-watch if a sixth arrives.
- **Parameter relay** — none: no function between `index.ts` and `GateRunner` passes the reader through.
  The rejected bash-local placement would have relayed it through `ToolCallGatePipeline` → `describeBashCommandGate` → `resolveBashCommandCheck`, three layers that only forward it.
- **Law of Demeter** — the reader is a closure over `configStore`, so the runner never reaches `config.yoloMode` through an injected object.
- **Repeated discriminators** — `origin === "yolo"` currently appears at one production site; after the change it is still one site (inside `resolveYoloGrant`), and `state === "ask"` reconciliation is decided once rather than per gate.

### Rejected alternatives

- **Reconcile inside `resolveBashCommandCheck`** (skip the floor when yolo is on).
  Narrower, but it leaves the `PermissionPrompter` contract unenforced — the next post-resolution floor re-opens the same bug — and it relays the reader through three layers (above).
- **Select an auto-approving `TerminalAuthorizer` under yolo.**
  Puts yolo back in the prompt path the [#526] design removed it from, and produces `waiting`/`approved` review entries instead of the single `auto_approved` entry, breaking log parity.
- **Express the floors as rules so the existing rewrite covers them.**
  The floor is a property of a parsed command unit (`wrapperKind`), not of a pattern, so there is no rule to write.

## Module-Level Changes

- `src/handlers/gates/bash-command.ts` — resolve the whole command in the zero-units/non-empty branch, return an explicit `deny`, otherwise keep the sentinel `ask`; update the function JSDoc paragraph describing that branch.
- `src/handlers/gates/helpers.ts` — add `resolveYoloGrant`.
- `src/handlers/gates/runner.ts` — add the `isYoloEnabled` constructor dependency; replace the step-2b condition with the `resolveYoloGrant` call; update the class/step comment to describe the two arms (ruleset grant, residual-ask grant).
- `src/index.ts` — hoist `isYoloEnabled` to a named local, pass it to both `PermissionManager` and `GateRunner`.
- `src/authority/permission-prompter.ts` — amend the class docstring: yolo is resolved upstream at composition **and** reconciled at the gate for post-resolution floors, so this class still has no yolo knowledge.
- `test/helpers/gate-fixtures.ts` — `makeGateRunner` gains a `yolo?: boolean` override (default `false`) and passes a reader to the fifth argument.
- `test/helpers/handler-fixtures.ts` — `makeHandler` gains a `yolo?: boolean` override; the `new GateRunner(...)` call at line 319 passes the reader.
- `test/helpers/external-directory-fixtures.ts` — the `new GateRunner(...)` call passes a `() => false` reader.
- `test/handlers/gates/bash-command.test.ts` — new deny case; the existing "fails closed to ask when a non-empty command parses to zero command units" test's `expect(resolver.resolve).not.toHaveBeenCalled()` becomes "called once, sentinel ask still returned".
- `test/bash-advisory-check.test.ts` — the same assertion at "fails closed for a non-empty command that parses to zero units" (`> out.txt`) becomes a single-consult assertion.
- `test/handlers/gates/helpers.test.ts` — unit tests for `resolveYoloGrant`.
- `test/handlers/gates/runner.test.ts` — yolo-on residual-ask, yolo-on deny, yolo-off ask, per-call reader tests.
- `test/composition-root.test.ts` — an end-to-end `describe` pinning the issue's literal repro through the real factory.
- `docs/architecture/architecture.md` — § "yolo is recorded authority": amend "the decision path loses all yolo knowledge" to name the one gate-level reconciliation for post-resolution floors, keeping the deny-preserving claim; update the `runner.ts` module-tree entry (line 766) to mention the live yolo reader and the two grant arms, and the `bash-command.ts` entry (line 779) to say the unparseable branch consults the ruleset for an explicit `deny` first.
- `docs/architecture/permission-prompter.md` — mirror the amended docstring sentence.
- `docs/configuration.md` — § "Fail-closed behavior": add that under `yoloMode: true` both floors are re-permitted at the gate (an explicit `deny` still denies), and qualify the now-absolute line "there is no way to auto-allow a wrapper"; extend the unparseable bullet with the explicit-deny consult; check the `yoloMode` row in the config table reads correctly against the new behavior.
- `.pi/skills/package-pi-permission-system/SKILL.md` — in the fail-closed/wrapper paragraph under Debugging, add that yolo re-permits both synthetic asks at the gate and that the unparseable branch consults the ruleset for an explicit `deny` first.

Greps run to build this list: `<indirection-bash-wrapper>` / `<unparseable-bash-command>` across `src/`, `test/`, `docs/`, `README.md`, and `.pi/skills/` (matches outside `docs/plans/` are the four files listed above); `new GateRunner` across `src/` and `test/` (four sites); `yolo` across `docs/` and `README.md` (README's only mention is project-trust scoping — no stale text).

## Test Impact Analysis

1. **Newly enabled tests.**
   `resolveYoloGrant` is a pure function, so the residual-ask policy gets direct unit coverage that was previously reachable only through a full descriptor run.
   The composition-root repro test is newly meaningful because the reader is wired end to end — it fails today and passes after step 2.
2. **Redundant tests.**
   None are removed.
   Two assertions invert from "the resolver is not consulted" to "consulted exactly once" — they were pinning an implementation detail that the deny fix deliberately changes; the surrounding fail-closed assertions stay.
3. **Tests that must stay as-is.**
   Every wrapper-floor case in `bash-command.test.ts` and `bash-command-metamorphic.test.ts` (yolo off, floors unchanged), the [#526] "yolo-origin allow" runner test (log/event parity), the yolo rewrite tests in `permission-manager-yolo.test.ts` and `rule.test.ts` (composition stage untouched), and `shell-tool-alias.test.ts` (aliased shell tools inherit the same path).

## Invariants at risk

| Invariant                                                                        | Source                 | Pinned by                                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A yolo grant produces exactly one `auto_approved` review entry + decision event  | [#526]                 | `test/handlers/gates/runner.test.ts` "returns allow and emits auto_approved on a yolo-origin allow without prompting" — must stay green **unmodified** |
| A non-empty command parsing to zero units never rides a permissive top-level `*` | [#452]                 | `bash-command.test.ts` zero-units test (assertion updated, fail-closed claim retained) and `bash-advisory-check.test.ts`                               |
| A wrapper's `allow` is floored to `ask`; an explicit `deny` still denies         | [#481], [#490], [#575] | `bash-command.test.ts` floor cases (yolo off)                                                                                                          |
| yolo preserves hard denies                                                       | [#526]                 | new runner test (yolo on + `deny` → block, escalator not called) and the composition-root deny case                                                    |
| The fail-closed `allow`→`ask` floor is re-permitted by yolo at composition       | [#646]                 | `permission-manager-yolo.test.ts` — composition stage untouched by this change                                                                         |
| The advisory answer is never weaker than the gate                                | [#309]                 | unchanged; under yolo the advisory becomes stricter than the gate, which is the safe direction                                                         |

Quantitative baseline (measured, composition-root harness): `git status | xargs grep foo` under `yoloMode: true` produces **1** prompt today and must produce **0** after; `git status | grep foo` produces **0** before and after.

## TDD Order

1. **Deny-preserving unparseable branch.**
   Red: `test/handlers/gates/bash-command.test.ts` — "returns the explicit deny when an unparseable command matches a deny rule" (resolver returns `deny` for the whole string → result is that deny, not the sentinel); update the existing zero-units test to expect one resolver consult and the sentinel `ask` when the whole-string rule is not `deny`; mirror the consult-count update in `test/bash-advisory-check.test.ts`.
   Green: the whole-command consult in `resolveBashCommandCheck` plus the JSDoc update.
   Commit: `fix(pi-permission-system): honor an explicit bash deny for an unparseable command (#712)`.
2. **Residual-ask yolo grant at the gate.**
   Red: `test/handlers/gates/helpers.test.ts` — `resolveYoloGrant` returns the check unchanged for a yolo-origin allow, a `{ state: "allow", origin: "yolo" }` copy preserving `matchedPattern` for an ask under yolo, and `null` for an ask with yolo off, an allow with another origin, and any deny.
   `test/handlers/gates/runner.test.ts` — with `yolo: true`, an `ask` check (sentinel `matchedPattern`) returns allow, never calls `escalate`, writes `permission_request.auto_approved`, and emits a decision with `resolution: "auto_approved"`, `origin: "yolo"`, and the sentinel preserved; a `deny` check still blocks without escalating; with `yolo: false` an `ask` still prompts; a reader flipped between two `run` calls changes the outcome (read per call).
   Green: `resolveYoloGrant` in `helpers.ts`, the fifth `GateRunner` dependency and the generalized step 2b, the three fixture updates, and the `index.ts` wiring — all in one commit, since the new required parameter breaks the type check otherwise.
   Commit: `fix(pi-permission-system): auto-approve residual synthetic asks under yolo (#712)`.
3. **End-to-end repro pin.**
   Red-then-green is inverted here by design (it passes as soon as step 2 lands), so it is written last to keep every commit green: `test/composition-root.test.ts` — a `describe` running the real factory with `yoloMode: true` and `bash: {"*": "allow"}` over `git status | xargs grep foo` (no `ui.select` call, not blocked), `> out.txt` (no prompt), `bash: {"*": "allow", "xargs*": "deny"}` (blocked), and `bash: {"*": "deny"}` + `> out.txt` (blocked).
   Commit: `test(pi-permission-system): pin the yolo wrapper and unparseable repro at the composition root (#712)`.
4. **Documentation.**
   The five doc/comment targets in Module-Level Changes.
   Commit: `docs(pi-permission-system): describe the gate-level yolo grant for post-resolution floors (#712)`.

## Risks and Mitigations

- **Auto-approval broadens beyond the reported bug.**
  A runner-level catch-all also covers a skill-read `preResolved` ask and any future synthetic ask.
  Mitigated by the enumeration in Background (only the stale-skill-entry case exists today, and auto-approving it is correct under yolo) and by the deny arm being structurally unreachable.
- **A masked `deny` becomes a silent grant.**
  This is the reason step 1 precedes step 2; without it, an unparseable command under an explicit `bash` `deny` would go from "prompted" to "auto-approved".
  Pinned by the composition-root deny case.
- **Review-log regression for the existing yolo path.**
  The first arm of `resolveYoloGrant` is the current condition verbatim and the [#526] test is not modified.
- **Fewer forwarded permission requests from subagents.**
  A child under yolo now resolves the floored ask locally instead of forwarding it to the parent.
  That is the intended contract (no ask reaches the escalator under yolo); no forwarding test asserts the old behavior.
- **Doc drift.**
  Three docs and one docstring currently assert a contract the code does not keep; step 4 corrects them together, and the pre-completion reviewer checks doc staleness.

## Open Questions

- Should the advisory path (`resolveBashAdvisoryCheck`) report the gate's yolo-adjusted answer instead of the floored `ask`?
  Deferred, not filed: the discrepancy is in the safe direction (advisory stricter than the gate), and no consumer is known to depend on gate parity under yolo.
  File an issue if an `Authorizer` link or sibling extension turns out to read it while yolo is on.
- Whether [#680]'s per-wrapper exemption config should subsume the yolo case once it lands — no; that config governs the floor itself, this change governs what yolo does with a floor that fired.

[#309]: https://github.com/gotgenes/pi-packages/issues/309
[#452]: https://github.com/gotgenes/pi-packages/issues/452
[#481]: https://github.com/gotgenes/pi-packages/issues/481
[#490]: https://github.com/gotgenes/pi-packages/issues/490
[#526]: https://github.com/gotgenes/pi-packages/issues/526
[#570]: https://github.com/gotgenes/pi-packages/issues/570
[#575]: https://github.com/gotgenes/pi-packages/issues/575
[#646]: https://github.com/gotgenes/pi-packages/issues/646
[#680]: https://github.com/gotgenes/pi-packages/issues/680
[#706]: https://github.com/gotgenes/pi-packages/issues/706
[#713]: https://github.com/gotgenes/pi-packages/issues/713
[#720]: https://github.com/gotgenes/pi-packages/issues/720
