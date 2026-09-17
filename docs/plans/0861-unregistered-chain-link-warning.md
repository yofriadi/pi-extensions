---
issue: 861
issue_title: "pi-permission-system: a locally-adjudicating child silently skips a configured chain link whose provider is excluded"
---

# Report a configured authorizer-chain link that is not registered in this session

## Release Recommendation

**Release:** ship independently

The issue is not a roadmap step.
Phase 15's `#### Open-issue sweep dispositions` deferred it twice, and the 2026-09-15 backlog triage promoted it above the phase spine by operator decision (Band 1, rank 3) — the same path [#875] took.
It carries no `Release:` tag and appears in no entry of the roadmap's `### Release batches` subsection, so nothing is waiting to ride with it.
The landing commit is a `fix:`, which cuts a patch release on its own.

## Problem Statement

An operator writes `"authorizerChain": ["model-judge"]` and expects that judge to review every `ask`.
When the node deciding the ask has no `model-judge` link registered, the ask is decided without it and **nothing outside a JSONL file says so**.

The reachable path is a subagent child that adjudicates locally.
`selectAuthorizer` tests `hasUI` first, so a child with its own UI decides its own asks; if the link's provider package is absent there — pi-subagents' `excludedExtensionPackages`, a load failure, or the provider declining to register — `AuthorizerSelection.resolveConfiguredLinks` finds no link, writes one `authorizer_chain_unregistered_link` review entry, and continues.
The human prompt then renders with no indication that the judge was skipped, and the operator cannot distinguish "the judge ran and deferred" from "the judge was never there" — the very distinction ADR 0007 §7 says the record exists to preserve.

This is measured, not hypothetical.
The operator's own review log (`pi-permission-system-permission-review.jsonl`, 12.4 MB) holds **48 genuine `authorizer_chain_unregistered_link` events across 13 distinct days** (2026-07-22 → 2026-08-18), every one naming `model-judge`. (A raw `grep -c` reports 54; six are the literal string inside a logged `bash` heredoc — an issue body — and are excluded.
Forty-four of the 48 predate the `requestId` field, so a `requestId`-keyed scan under-counts them; this is the schema-drift hazard the package skill warns about.)

The fail-safe **resolution** is correct and is not in question.
ADR 0012 decision 1 keeps live authority converged at the adjudicating node, and `docs/decisions/0012-cross-node-extension-contract.md` already records why a link (a verdict) is not a fact-shaping registration (an extractor) and must not be inherited across a node boundary.
The silence is the defect.

## Goals

- A locally-adjudicating node that skips a configured `authorizerChain` name raises a **visible** warning naming the link, once per session per name.
- The warning admits all three causes of a missing link without guessing which applies.
- The existing per-ask `authorizer_chain_unregistered_link` review entry is unchanged in shape, volume, and meaning.
- A relaying node still cannot produce either record — its configured names are `authorizer_chain_delegated`, by design.

This change is **not breaking**: it adds a warning and changes no decision, default, output shape, or config surface.
Nothing an existing consumer reads changes value.

## Non-Goals

- **Inheriting a link registration from an ancestor node.**
  Explicitly rejected by ADR 0012 decision 1 and ADR 0007 §7, and guarded by the `fact-shaping inheritance stops at live authority` test in `test/composition-root.test.ts`.
  The skip stays; only its reporting changes.
- **Reporting at turn prep, before the first ask.**
  Considered and declined at the clarification gate.
  ADR 0007 §4 requires a link only to be registered *before the session's first ask*, so a prep-time report is a prediction about a registration that has not yet had all its permitted time to land — it would falsely accuse a conforming extension that registers asynchronously from its `permissions:ready` handler.
  Reporting at the skip reports a fact.
- **A chain-health line in `/permission-system show`.**
  Offered as option C at the gate and declined.
  No edit to `src/config/config-modal.ts`.
- **Branching the message on subagent detection.**
  Declined at the gate: it would add a `SubagentDetector` read to the audit and would be wrong for a root session whose provider is merely uninstalled.
- **Any change to `authorizer_chain_resolved`, `authorizer_chain_delegated`, or `authorizer_link_vacant`.**
- **Any config field, schema entry, or example-config change.**
  The warning is unconditional; it needs no knob.
- **Amending ADR 0007.**
  §4 invariant 2 already says a missing name is "skipped with a warning"; this change makes that warning reach the operator rather than only the log, so it fulfils the decision rather than altering it.

## Background

### Where the skip happens

`AuthorizerSelection` (`src/authority/authorizer-selection.ts`) resolves the chain **per ask**, not at activation, because ADR 0007 §4 lets a link register in a `permissions:ready` handler that fires after activation.

`linksFor` returns early on a relaying node, recording `authorizer_chain_delegated`, so `resolveConfiguredLinks` runs **only** on a node that adjudicates locally.
Inside it, the loop writes the review entry inline:

```typescript
for (const name of configured) {
  const authorize = this.deps.authorizerRegistry.get(name);
  if (authorize === undefined) {
    this.deps.logger.review("authorizer_chain_unregistered_link", {
      requestId,
      name,
    });
    continue;
  }
  resolved.push(name);
  links.push({ name, authorize: encloseInDelegationEnvelope(authorize) });
}
```

That early return is the structural reason a relaying node can never emit this warning, and it must stay that way.

### The precedent this copies

[#792] shipped `ChildNodeAudit` (`src/authority/child-node-audit.ts`) for the sibling problem — an in-process child with no permission node at all.
Its shape is the template: a narrow `{ review, warn }` log seam (ISP), an exported message builder (`childNodeAbsentMessage`), a one-method seam interface (`BoundChildAuditor`), and a class holding the warn-once latch.
Its message also names the likeliest cause and admits the other in the same sentence, which is exactly the wording problem here.

The latch lifecycle carries over verbatim: the extension factory is re-invoked per session generation, so a `/new`, `/resume`, `/fork`, or `/import` switch builds a fresh audit, while a `session_start` with `reason: "reload"` reuses the instance and deliberately does not re-warn.
A newly *added* link name has no latch entry, so a reload that adds one to `authorizerChain` still warns for it.

### Why a warning is the right surface, verified

`ctx.ui.notify(message, "warning")` is **durable scrollback, not a transient toast**.
Traced in the Pi checkout: `InteractiveMode.showExtensionNotify` dispatches `"warning"` to `showWarning`, which does `chatContainer.addChild(new Text(...))` — the same container as conversation history, with no timer and no auto-dismiss.
The permission dialog uses `ui.select`, implemented by `showExtensionSelector`, which swaps the **editor area** and never calls `showOverlay`; `documentContainer` (holding `chatContainer`) and `editorContainer` are disjoint stacked regions.
So a warning emitted immediately before the prompt sits in scrollback directly above the prompt asking the question the judge should have answered, and cannot be covered by it.

### A missing link is not always a contradiction

`pi-permission-model-judge`'s ready handler opens with `if (dispose || !config) return;`, commented "a session with no config of its own registers nothing: that is the operator declining the link."
Under ADR 0007 §5's two-config split, a user who names a link in `authorizerChain` but has no provider config for this project gets a **deliberate** non-registration.
The message must therefore admit three causes — not loaded here, failed to load, declined to register — rather than asserting a contradiction.

### Constraints from AGENTS.md and the package skill

- Do not add a `getAuthorizer` reader to `PermissionsService`, and do not give `AuthorizerRegistry` the ancestor fallback `inherited-registrations.ts` gives the extractor and formatter lookups.
- Within the package, `./` names a same-directory module and `#src/`/`#test/` a cross-directory one; both halves are lint-enforced with auto-fixes.
- A new module goes to its named directory when it is written — `authority/` here (subagent detection, the `Authorizer` spine, forwarding).
- The `warn` sink is `session.notify(message)` → `ctx.ui.notify(message, "warning")`, already wired into `PermissionSessionLogger` in `src/index.ts`.

## Design Overview

One new collaborator, one call-site swap, one wiring line.

### The audit module

New file `src/authority/authorizer-chain-audit.ts`, modelled on `child-node-audit.ts` rather than sharing code with it (see "Rejected: a shared audit base" below).

```typescript
/** The narrow log seam this audit needs (ISP): a durable record and a warning. */
export interface AuthorizerChainAuditLog {
  review(event: string, details?: Record<string, unknown>): void;
  warn(message: string): void;
}

/** A configured chain link this node's registry could not resolve. */
export interface UnregisteredLink {
  /** The operator-configured name, as written in `authorizerChain`. */
  name: string;
  /** The ask whose resolution skipped it. */
  requestId: string;
}

/** The audit seam `AuthorizerSelection` drives when it skips a name (ISP). */
export interface UnregisteredLinkAuditor {
  auditUnregisteredLink(link: UnregisteredLink): void;
}

export function unregisteredLinkMessage(name: string): string;

export class AuthorizerChainAudit implements UnregisteredLinkAuditor {
  private readonly warned = new Set<string>();
  constructor(private readonly log: AuthorizerChainAuditLog) {}
  auditUnregisteredLink(link: UnregisteredLink): void;
}
```

`auditUnregisteredLink` writes the review entry for **every** skip — the durable record must stay complete, so its volume is unchanged — and then warns only the first time it sees a given `name`.
The latch is keyed on the name rather than a plain boolean because the bound is `authorizerChain.length` (1 in the reporting configuration), and a second name going missing later is a second misconfiguration worth surfacing.

The message, unbranched, naming three causes in likelihood order:

```text
pi-permission-system: authorizerChain names "model-judge", but no link with
that name is registered in this session, so this ask is being decided without
it. Most often the extension providing the link is not loaded here (a subagent
child's excludedExtensionPackages does this); it may also have failed to load,
or declined to register because it has no configuration of its own. Every
skipped ask is recorded in the permission review log as
authorizer_chain_unregistered_link.
```

Every clause is a statement of fact about what already happened, matching the chosen reporting point.
It deliberately does not claim later asks will also skip the link — a late registration is permitted by ADR 0007 §4 and would make that claim false.

### The call-site swap

`AuthorizerSelection`'s constructor dependency bag gains one required field, `chainAudit: UnregisteredLinkAuditor`, and the loop body becomes:

```typescript
const authorize = this.deps.authorizerRegistry.get(name);
if (authorize === undefined) {
  this.deps.chainAudit.auditUnregisteredLink({ requestId, name });
  continue;
}
```

This is Tell-Don't-Ask: the selection tells the audit that a name was skipped and learns nothing back; the audit owns both halves of the alarm and the policy for how loudly each fires.
It also keeps `AuthorizerSelectionDeps.logger` at its current narrow `DebugReviewLogger` type — widening it to something carrying `warn` would hand every collaborator of `selectAuthorizer` a capability only this one path needs.

The `adjudicatesLocally` early return in `linksFor` is untouched, and remains the only thing standing between a relaying node and a spurious warning.

### Wiring

In `src/index.ts`, beside the existing `AuthorizerSelection` construction:

```typescript
const chainAudit = new AuthorizerChainAudit(logger);
```

`logger` is the `PermissionSessionLogger` already constructed above; it satisfies `AuthorizerChainAuditLog` structurally with `review` and `warn`, and its `warn` routes through `session.notify`.
The instance is created inside the extension factory, so it is rebuilt per session generation — which is what makes "once per session" the latch's real scope, with no reset hook to maintain.

### Rejected: a shared audit base with `ChildNodeAudit`

The two audits latch differently: `ChildNodeAudit` warns once per instance (`private warned = false`), because its cause set is unbounded (a parent can fan out ten children); this one warns once per configured name, because its cause set is bounded by the config array and each name is a distinct misconfiguration.
A shared base would need a "warn key" strategy parameter existing only to paper over that difference.
Duplicating the ~40-line shape is the correct call under this repo's stated position that duplication is cheaper than the wrong abstraction.
The two files stay independent siblings in `src/authority/`.

## Module-Level Changes

### Added

- `packages/pi-permission-system/src/authority/authorizer-chain-audit.ts` — the audit module above.
- `packages/pi-permission-system/test/authority/authorizer-chain-audit.test.ts` — unit tests for the latch, the per-skip review entry, and the message.
  Use `makeLogger()` from `test/helpers/session-fixtures.ts` (a full `{ debug, review, warn }` `SessionLogger`), the same fixture `child-node-audit.test.ts` uses — **not** `makeAuthorizerLog()` from `test/helpers/authorizer-log-fixtures.ts`, which returns only `{ review, debug }` and has no `warn`.

### Changed

- `packages/pi-permission-system/src/authority/authorizer-selection.ts` — export the constructor bag as a named type `AuthorizerSelectionConstructorDeps` (step 1); add the required `chainAudit` field; replace the inline `logger.review` call in `resolveConfiguredLinks` with `chainAudit.auditUnregisteredLink({ requestId, name })`; update the method's doc comment, which currently describes the skip as recorded by a "logged warning".
- `packages/pi-permission-system/src/index.ts` — construct `AuthorizerChainAudit` from `logger` and pass it into `new AuthorizerSelection({ … })` (the call around the `getAuthorizerChain` line).
  This is the single call site of the constructor, so it must change in the same commit as the required field.
- `packages/pi-permission-system/test/helpers/authorizer-fixtures.ts` — `AuthorizerSelectionTestDeps` stops hand-copying the four extra constructor fields and becomes `Omit<AuthorizerSelectionConstructorDeps, "authorizerRegistry"> & { authorizerRegistry: AuthorizerRegistry }` (step 1); `makeAuthorizerSelectionDeps` gains a `chainAudit` default (a `vi.fn()`-backed `UnregisteredLinkAuditor` double).
  This is the shared-fixture case AGENTS.md warns about for a **new required** field: the field never existed, so no `chainAudit: undefined` literal exists to grep for.
- `packages/pi-permission-system/test/authority/authorizer-selection.test.ts` — `skips an unregistered configured name with a warning` and `does not report an unregistrable link as an unregistered one` move their assertions from the `logger.review` spy to the audit double; new tests cover the warn-once-per-name behavior at the selection seam.
- `packages/pi-permission-system/test/composition-root.test.ts` — the `fact-shaping inheritance stops at live authority` block already asserts the review log contains `authorizer_chain_unregistered_link` (it drives a child with its own UI and a parent-only link, which **is** this issue's scenario end to end).
  The relocated call site must keep that assertion green, and the block gains an assertion that the child's `ctx.ui.notify` received the warning — the one place the whole wiring is exercised.

### Documentation

- `packages/pi-permission-system/docs/configuration.md` — the *Authorizer chain* section's invariant 2 ("A name with no registered link is skipped with a logged warning") and the review-record table row for `authorizer_chain_unregistered_link`: both now say the skip also raises a one-time visible warning naming the link, and that a session with no provider config for the link is one of its causes.
- `packages/pi-permission-system/docs/architecture/architecture.md` — the module-tree entry for `authorizer-selection.ts` (it currently says unregistered names are "skipped fail-safe with an `authorizer_chain_unregistered_link` review event"); a new tree entry for `authorizer-chain-audit.ts`.
  Per the architecture-doc convention these describe **current behavior**; cite ADR 0007 §7 for the relaying-node exclusion (an active constraint), not this issue number.
  Also add a line to Phase 15's `#### Open-issue sweep dispositions` noting the issue was pulled forward by operator decision and shipped outside the phase, in the form the [#875] entry already uses.
- `packages/pi-permission-system/docs/decisions/0012-cross-node-extension-contract.md` — the sentence calling the live-authority case a separate question about whether that fail-safe skip should be louder, tracked as this issue, is stale once the question is answered; rewrite it to record the answer (the skip stands; it is now reported visibly once per session per name).
  Keep that file's reference definition for this issue only if the rewritten sentence still cites it.
- `.pi/skills/package-pi-permission-system/SKILL.md` — the sentence "A locally-adjudicating child skipping a configured link whose provider did not load there is a separate question, tracked as #861" becomes a statement of the shipped behavior.

Grep sweep performed at planning time over `src/`, `test/`, `packages/pi-permission-system/docs/` (excluding `docs/plans/` and `docs/architecture/history/`), and `.pi/skills/` for `authorizer_chain_unregistered_link` and `861`; the list above is its complete result.
No symbol is removed or renamed, so no removed-export sweep applies.

### Predicted unchanged, with the claim each rests on

- `packages/pi-permission-system/README.md` — its three `authorizerChain` lines describe opt-in activation, config order, and the delegation envelope, and make no claim about how a missing link is reported.
- `packages/pi-permission-system/docs/decisions/0007-model-judge-authorizer-chain-adr.md` — §4 invariant 2 already reads "skipped with a warning" and §7 already states what the record means; the change fulfils both rather than altering either.
- `src/config/config-schema.ts`, `schemas/permissions.schema.json`, `config/config.example.json` — no config field is added, so the generated-schema parity test in `test/config-schema.test.ts` is unaffected.
- `src/authority/authorizer-registry.ts`, `src/authority/inherited-registrations.ts`, `src/service.ts` — registration and lookup semantics are untouched; only the reporting of an unresolved name changes.
- `docs/architecture/history/` — closed-phase records are history and are not edited.

## Test Impact Analysis

### What the new module makes testable that was not

The latch, the message text, and the per-skip record are currently reachable only by driving a whole `AuthorizerSelection` through `escalate` with a stubbed prompter.
As a separate module they are unit-testable directly: warn-once-per-name, warn-again-for-a-different-name, and review-entry-on-every-skip each become a three-line test against a `makeLogger()` double.

### What becomes redundant

Nothing is removed.
`skips an unregistered configured name with a warning` keeps its full-decision assertion — it is the pin for ADR 0007 §4 invariant 2 (the ask still reaches the terminal and `present` is the credited decider), which the audit module cannot cover.
Only its logging assertion moves to the audit double.

### What must stay as-is

- `does not report an unregistrable link as an unregistered one` — the relaying-node negative, which exercises `linksFor`'s early return and belongs at the selection layer.
- `records the resolved link names on the ask`, `records only the names it could resolve`, `records no consultation when no configured name resolved` — they pin that `authorizer_chain_resolved` is written only when at least one name resolved.
- The `fact-shaping inheritance stops at live authority` composition-root block — the only end-to-end exercise of the real wiring.

## Invariants at Risk

| Invariant                                                                                        | Source                                      | Pinned by                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A missing name is skipped fail-safe; the ask still reaches the terminal                          | ADR 0007 §4 invariant 2                     | `skips an unregistered configured name with a warning` (asserts the full decision, credited to `present`)   |
| A relaying node records `authorizer_chain_delegated`, never `authorizer_chain_unregistered_link` | ADR 0007 §7                                 | `does not report an unregistrable link as an unregistered one`; `records the configured names as delegated` |
| Live authority does not inherit across a node boundary                                           | ADR 0012 decision 1                         | `fact-shaping inheritance stops at live authority` (`test/composition-root.test.ts`)                        |
| The review entry keeps its exact `{ requestId, name }` shape and per-ask volume                  | `docs/configuration.md` review-record table | `skips an unregistered configured name with a warning`; the new audit unit test                             |
| `authorizer_chain_resolved` is written only when ≥ 1 name resolved                               | ADR 0007 §7                                 | `records only the names it could resolve`; `records no consultation when no configured name resolved`       |

### Quantitative prediction

The review stream is unchanged: the same 48 events measured over the 2026-07-22 → 2026-08-18 window would still be 48, with identical fields.
The visible stream is new and bounded by one warning per session per configured name — over that same window, at most one per session rather than the 23 that landed on 2026-08-05 alone.

### Constituencies

The review entry serves the post-hoc auditor reading JSONL, and it must stay complete and per-ask for that reader; the warning serves the operator at the prompt, for whom a repeat is noise.
Splitting the rates is the point, and it is why the audit writes both rather than the selection writing one and the audit the other.

### Accepted residual: a headless locally-adjudicating node

When `ctx.hasUI` is false, Pi's extension runner hands the extension `noOpUIContext`, whose `notify` is literally `() => {}` — verified in the Pi checkout's `core/extensions/runner.ts`.
A headless node that adjudicates locally (its terminal is `DenyingAuthorizer`) therefore gets the review entry and no visible warning.
This is inherent to the surface, not to the design: there is no user watching to warn.
The issue's reachable path has a UI, since that is what makes the child adjudicate locally in the first place.

### Accepted residual: a session where no ask escalates

Under `yoloMode`, `resolveYoloGrant` grants residual asks at `GateRunner`'s auto-approve fast path, so `escalate` never runs and no skip is ever observed.
Such a session never learns its chain is broken.
This is the known cost of reporting a fact instead of a prediction, and the operator accepted it at the clarification gate in preference to a prep-time check that could falsely accuse a conforming late registrar.
It is recorded here rather than filed, because the alternative that covers it was considered and declined.

## TDD Order

### 1. `refactor(pi-permission-system): name AuthorizerSelection's constructor deps`

Preparatory (Tidy First).
The constructor bag is an anonymous `AuthorizerSelectionDeps & { prompter; getPermissionQuery; authorizerRegistry; getAuthorizerChain }` intersection, and `AuthorizerSelectionTestDeps` in `test/helpers/authorizer-fixtures.ts` hand-copies the same four extra fields.
Step 3 adds a fifth field, which without this step must be added in **both** places in the same commit.

Export `AuthorizerSelectionConstructorDeps` from `authorizer-selection.ts`, use it as the constructor's parameter type, and redefine the fixture type as `Omit<AuthorizerSelectionConstructorDeps, "authorizerRegistry"> & { authorizerRegistry: AuthorizerRegistry }` (the fixture needs the concrete registry so tests can `register(...)` into it; the class needs only the `AuthorizerLookup` read side).

Pure type-level change: no runtime behavior differs.
Verify with `pnpm run check` and the full package suite; no killing mutation applies, because the step adds no test.

### 2. `refactor(pi-permission-system): add the authorizer-chain audit`

Red: `test/authority/authorizer-chain-audit.test.ts` fails because the module does not exist.
Green: create `src/authority/authorizer-chain-audit.ts` with the seam, the message builder, and the class.

Typed `refactor:` because nothing imports it yet — a user observes nothing from this commit.

Tests, one per equivalence class:

- writes `authorizer_chain_unregistered_link` with `{ requestId, name }` on every call, including a repeat for the same name;
- warns exactly once for a repeated name;
- warns again for a **different** name;
- the message names the link and each of the three causes.

Killing mutations:

- Make `auditUnregisteredLink` return immediately after the latch check, before `log.review(...)` → the "records every skip" tests go red, the warn tests stay green.
- Replace the `warned.has(name)` guard with `false` → the warn-once test goes red, the different-name and review tests stay green.
- Replace the `Set<string>` latch with a `private warned = false` boolean → the different-name test goes red, the warn-once and review tests stay green.

### 3. `fix(pi-permission-system): warn when a configured authorizer-chain link is not registered`

The observable change, and one commit by necessity: adding a required field to `AuthorizerSelectionConstructorDeps` breaks `src/index.ts` (the single call site) and `test/helpers/authorizer-fixtures.ts` at compile time.

Red: a new selection test asserting the audit double received `auditUnregisteredLink({ requestId, name })` fails.
Green: add the `chainAudit` field, swap the loop body, wire `new AuthorizerChainAudit(logger)` in `index.ts`, add the fixture default, and migrate the two existing logging assertions onto the double.
Add the `ctx.ui.notify` assertion to `fact-shaping inheritance stops at live authority` in `test/composition-root.test.ts` in this commit.

The subject names the observable outcome, not the seam — it ships to the changelog verbatim.

Killing mutations:

- Delete the `chainAudit.auditUnregisteredLink(...)` call and restore the inline `logger.review(...)` → the new selection test and the composition-root `notify` assertion go red; the existing review-entry assertions stay green (which is the point: the old code satisfied them).
- Move the audit call above `linksFor`'s `adjudicatesLocally` early return → `does not report an unregistrable link as an unregistered one` goes red.
- Construct the audit inside the `AuthorizerSelection` constructor instead of injecting it → the fixture's double is never consulted and every step-3 assertion goes red, which is the DIP pin.

Run `pnpm run check` immediately after this commit (shared-interface change), then the full package suite — not only the files the grep matched.

### 4. `docs(pi-permission-system): record the unregistered-link warning`

All five documentation touch points from *Module-Level Changes* → *Documentation*, in one commit.
No `✅` roadmap marker applies: the issue is a sweep disposition promoted by operator decision, not a numbered step.

Verify with `pnpm exec rumdl check` on each edited markdown file and `pnpm run lint`.

## Risks and Mitigations

| Risk                                                                                                                                               | Mitigation                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The warning fires on a deliberate non-registration (a provider that declines because it has no config for this project) and reads as an accusation | The message names that cause explicitly, as the third of three; it states what happened, never that the operator erred                                                                                                    |
| A relaying node starts warning — the exact noise ADR 0007 §7 was written to stop                                                                   | The audit is called only from `resolveConfiguredLinks`, which `linksFor` reaches only after its `adjudicatesLocally` check; pinned by an existing test and by a named killing mutation in step 3                          |
| The review log's per-ask completeness is lost when its write moves into a latched class                                                            | The latch guards only `warn`; `review` is written on every call, pinned by a repeat-name test and by a killing mutation that returns early                                                                                |
| Moving the review write changes its fields or ordering                                                                                             | The audit builds the same `{ requestId, name }` object; the existing selection assertion and the composition-root log assertion both survive unchanged                                                                    |
| Warning volume in a fan-out session                                                                                                                | The latch is per session per name and the config array is short (one entry in the reporting configuration); measured worst case over the sampled window drops from 23 records in a day to at most one warning per session |
| A test fixture silently absorbs the new required field                                                                                             | The field is new, so no `chainAudit: undefined` literal exists to grep; `tsc` rejects every construction site instead, and `pnpm run check` runs immediately after step 3                                                 |

## Open Questions

- Whether a session that never escalates an ask (notably under `yoloMode`) deserves any report at all is deferred, not unknown: the two mechanisms that would cover it — a turn-prep check and a `/permission-system show` chain-health line — were both put to the operator at the clarification gate and declined.
  Nothing is filed; it is recorded above as an accepted residual so a future reader sees the decision rather than the gap.
- Whether an operator can connect a link *name* to the package that registers it remains partly open, as the issue notes.
  `registerAuthorizer(name, authorize)` carries no provider identity, so the message cannot name a package.
  Giving the registry a provenance field is a service-surface change well beyond this fix and is not proposed here.

[#792]: https://github.com/gotgenes/pi-packages/issues/792
[#875]: https://github.com/gotgenes/pi-packages/issues/875
