---
issue: 423
issue_title: "pi-subagents: make the agent widget self-drive from lifecycle events"
---

# Retro: #423 — Make the agent widget self-drive from lifecycle events

## Stage: Planning (2026-06-17T00:00:00Z)

### Session summary

Planned Phase 18 Step 4 of the widget/tool decoupling track: making `AgentWidget` a `SubagentManagerObserver` that self-drives its 80 ms timer from lifecycle notifications, wired via a new `CompositeSubagentObserver` fan-out, and removing all inbound widget calls from the spawn tools.
Wrote a four-step plan (three `refactor:` commits + a `docs:` sweep) at `packages/pi-subagents/docs/plans/0423-widget-self-drive-from-lifecycle.md`.

### Observations

- **Wiring mechanism was the live design decision.**
  `SubagentManager` has a single `observer` slot.
  Three options surfaced: (A) a `CompositeSubagentObserver` fan-out in `index.ts`, (B) make the manager hold an observer list, (C) subscribe the widget to the public `pi.events` channels.
  The operator initially leaned toward B (matching the issue's literal file list) but was unsure; after reframing around the decouple + overridable-UI north star, they chose **A**.
  Rationale recorded in the plan: A keeps the core closed for modification, B moves fan-out *into* the core (wrong direction), and C front-runs the Step 6 ([#425]) public-event-contract reconciliation.
  Key insight that flattened the decision: all three options keep the widget's `manager.listAgents()` reference, so they only change the *trigger*, not the data source — full broadcast-plus-query decoupling is the Step 8 ([#427]) concern.
- **`markFinished` is fully redundant** and is deleted, not relocated: `seedFinishedAgents()` (added in [#421] / [#422]) already seeds any agent with `completedAt` on each poll tick.
  This matters because the manager **never fires `onSubagentCompleted` for foreground agents** (`onRunFinished` guards on `isBackground`), so the widget could not learn of foreground completion via the observer anyway — polling covers it.
- **Construction cycle** (widget needs manager → manager needs observer → observer includes widget) is broken by constructing the composite with `[eventsObserver]`, passing it to the manager, then `observer.add(widget)` after the widget is built; the manager consults the observer only lazily at spawn time.
- **TDD ordering avoids a behavior gap:** Step 2 wires the widget as an observer *while the spawn tools still drive it* (idempotent double-drive), strictly before Step 3 removes the spawn-tool calls — so no commit leaves the widget without a timer-start signal.
  The new widget observer methods need no `fallow-ignore` because they are invoked polymorphically through `SubagentManagerObserver` (the `SubagentEventsObserver` precedent).
- This step narrows `AgentToolWidget` to `setUICtx` only but keeps the `AgentTool` widget constructor param; full removal is Step 5 ([#424]).
- Non-breaking and internal-only (no public service/settings surface touched), so `refactor:`/`docs:` commits, no `BREAKING CHANGE` footer.

## Stage: Implementation — TDD (2026-06-17T10:00:00Z)

### Session summary

Executed the four-step plan exactly as written: added `CompositeSubagentObserver` (Step 1), made `AgentWidget` a `SubagentManagerObserver` and wired the composite in `index.ts` (Step 2), removed all spawn-tool widget wiring and deleted `markFinished` (Step 3), then swept the architecture doc + SKILL.md (Step 4).
Four commits (three `refactor:`, one `docs:`); test count `1032 → 1039` (+7 composite, +4 widget observer, −4 removed spawner/fixture widget-driving tests).
`check`, root `lint`, full `test`, and `fallow dead-code` all green; pre-completion reviewer returned PASS.

### Observations

- **Mid-step correction (not a separate commit):** in Step 2 I initially over-reached by deleting `markFinished` and privatizing `ensureTimer`, which breaks `index.ts` typing because `AgentToolWidget` still required those methods until Step 3.
  Caught it before committing and reverted both to Step 3 per the plan; Step 2 kept them public.
  The plan's ordering (narrow `AgentToolWidget` and delete `markFinished` only in the atomic Step 3 removal) was correct — the lesson is to trust the step boundaries.
- **Biome `useIterableCallbackReturn` false trigger:** naming the composite's private fan-out helper `forEach` made Biome treat the call as `Array.prototype.forEach` and reject the value-returning arrow.
  Renamed it to `dispatch` — a strictly better name anyway.
- **`vi.getTimerCount()` cleanly proves the timer started:** the widget observer tests assert `getTimerCount()` goes `0 → 1` on `onSubagentStarted`/`onSubagentCreated`, distinguishing `startLoop` (ensureTimer + render) from a bare `update()` (render only), with the manager-stub creating no other timers.
- **No dead-code window:** the widget's new observer methods are invoked polymorphically through `SubagentManagerObserver` (the `SubagentEventsObserver` precedent), so `fallow` saw them as used from Step 2 onward; `ensureTimer` became `private` in Step 3, dropping its now-stale `fallow-ignore`.
- **The Step 2 transient double-drive was harmless** as predicted: both the spawn tools and the composite drove the widget in that commit, and every driven method is idempotent — full suite green at that commit.
- **Reviewer notes (non-blocking, both PASS):** a pre-existing "six domains" vs "seven domains" inconsistency in `architecture.md` (Phase 17, out of scope, left alone); and `observer.add(widget)` is a justified post-construction write documented as the only construction-cycle break (widget needs manager, manager needs observer).
- **Pre-completion reviewer: PASS** — all deterministic checks, code-design, test-artifact, Mermaid (`mmdc` parsed all 6 blocks), dead-code, and cross-step-invariant lenses passed.

## Stage: Final Retrospective (2026-06-17T18:30:00Z)

### Session summary

Shipped Phase 18 Step 4 across plan → TDD → ship in a single session: the `AgentWidget` became a `SubagentManagerObserver` that self-drives its 80 ms timer through a new `CompositeSubagentObserver` fan-out, and the spawn tools shed every widget call.
Four implementation commits (three `refactor:`, one `docs:`), pre-completion reviewer PASS, CI green, issue closed; no release (all commits non-releasing).
Execution was clean — two self-caught agent-side slips, no rework commits, and the only user input was one productive redirect plus a release-timing answer.

### Observations

#### What went well

- **Two-round `ask_user` on the wiring decision (planning).**
  The first round offered three mechanisms (composite / manager-list / `pi.events`); the operator picked B but flagged uncertainty.
  Reframing around the decouple + overridable-UI north star and re-asking flipped the choice to A (`CompositeSubagentObserver`) with explicit buy-in.
  The reframe surfaced the insight that flattened the decision: all three options keep the widget's `manager.listAgents()` reference, so they change only the *trigger*, not the data source.
- **`vi.getTimerCount()` as a precise timer-start assertion.**
  The widget observer tests assert `getTimerCount()` goes `0 → 1` on `onSubagentStarted`/`onSubagentCreated`, cleanly distinguishing `startLoop` (timer + render) from a bare `update()` (render only).
- **"Double-drive" lift-and-shift ordering.**
  Step 2 wired the new observer while the spawn tools still drove the widget (idempotent overlap), and Step 3 removed the old path — no commit left the widget without a timer-start signal, and the full suite was green at every commit.
- **Incremental verification cadence.**
  `pnpm run check` after each shared-type change, `vitest` per-file in red/green, `mmdc` on all 6 Mermaid blocks, and `fallow`/`lint`/full-suite at the end of Step 3 — no end-only verification.

#### What caused friction (agent side)

- `scope-drift` (self-identified) — in TDD Step 2 I deleted `markFinished` and privatized `ensureTimer` ahead of schedule; both belonged to the atomic Step 3 removal because `AgentToolWidget` still required them until then (deleting early breaks `index.ts` typing).
  Caught by reasoning before committing and reverted to Step 3.
  Impact: a few corrective edits, no extra commit, no rework.
  Lesson: re-read the step's exact scope before editing, rather than editing from the overall design held in memory.
- `missing-context` (self-identified) — naming the composite's private fan-out helper `forEach` tripped Biome's `useIterableCallbackReturn` (it treated the call as `Array.prototype.forEach` and rejected the value-returning arrow).
  Renamed to `dispatch`.
  Impact: one rename, caught immediately by the `pi-autoformat` hook; no rework.
- `other` — the ship stage asked the batch-vs-release question for a multi-issue sequence, but every unreleased commit was `refactor:`/`docs:`, so release-please produced no PR regardless of the answer.
  The operator's "release now" answer was therefore unactionable (the work auto-batches until a `feat`/`fix` lands).
  Impact: one unactionable `ask_user` round; correct outcome reached, but the question implied a choice that did not exist.

#### What caused friction (user side)

- None blocking — the planning redirect ("I'm not confident in my choice… the goal is to decouple… an event system would make sense but isn't on the roadmap") was the ideal intervention: a redirecting question that handed over the north star instead of a post-hoc correction, and it directly produced the better design.

### Diagnostic details

- **Model-performance correlation** — Planning ran on `anthropic/claude-opus-4-8` (design + the two-round wiring `ask_user`; appropriate).
  TDD ran on `anthropic/claude-sonnet-4-6` (implementation; handled the Step 2 self-correction and the Biome rename; adequate).
  The `pre-completion-reviewer` subagent ran on `anthropic/claude-sonnet-4-6` (its frontmatter) and returned a thorough PASS.
  Ship ran on `opencode-go/deepseek-v4-flash` — a reasoning-weak model carrying the batch-vs-release judgment and the "no release PR expected" inference.
  It reached the correct outcome, but this is the same latent risk the #422 retro flagged: a weak model on the one ship-stage judgment call.
  Proposal 1 mitigates it by making the release-trigger check deterministic so the stage needs no judgment.
- **Escalation-delay tracking** — no `rabbit-hole`s; both agent-side slips resolved in one tool call each (one rename, one revert); no sequence exceeded 5 calls on one error.
- **Unused-tool detection** — no `missing-context` gaps requiring a subagent; `grep` (not `colgrep`) was used in planning, correctly — every search was an exact symbol match (`ensureTimer`, `markFinished`, `observer`).
- **Feedback-loop gap analysis** — no gap; verification was incremental, not end-only (see "What went well").

### Changes made

1. `.pi/prompts/ship-issue.md` — step 4b now opens with a release-trigger gate: check `git log --oneline <last-tag>..HEAD`, and when every commit is a non-releasing type (`refactor:`/`docs:`/`style:`/`chore:`/`test:`), state that release-please cuts nothing now and skip the batch-vs-release question.

[#421]: https://github.com/gotgenes/pi-packages/issues/421
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#424]: https://github.com/gotgenes/pi-packages/issues/424
[#425]: https://github.com/gotgenes/pi-packages/issues/425
[#427]: https://github.com/gotgenes/pi-packages/issues/427
