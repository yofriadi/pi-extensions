---
issue: 70
issue_title: "refactor: extract event handlers from pi-subagents index.ts into src/handlers/"
---

# Retro: #70 — extract event handlers from index.ts

## Final Retrospective (2026-05-20T19:30:00Z)

### Session summary

Planned and implemented #70 — extracting four inline event handler lambdas from `src/index.ts` into `src/handlers/lifecycle.ts` (`SessionLifecycleHandler` class) and `src/handlers/tool-start.ts` (`ToolStartHandler` class).
During planning, the user identified that the initial plain-function design missed shared collaborators and structural smells, prompting a redesign to class-based handlers and a predecessor issue (#87) to evolve `SubagentRuntime` from a data bag to an object with methods.
Released as `pi-subagents-v5.8.0` with 8 new handler tests (520 total).

### Observations

#### What went well

- The user's progressive questioning during planning ("Are you confident?", "Keep digging", Kent Beck quote) surfaced two concrete structural smells — output arguments on `runtime.currentCtx` writes and 8 LoD violations via `runtime.widget!` reach-throughs — that the initial design would have just relocated rather than fixed.
- Filing predecessor #87 was the right sequencing call.
  By the time #70 executed, the runtime had proper methods and the handler extraction was purely mechanical.
- The 3-step TDD cycle executed cleanly with zero rework or deviations from the plan.
  The only issue was a `tsc` type error (`vi.fn()` return type not assignable to `() => void`) caught during the post-TDD type check and fixed in-place before the final commit.

#### What caused friction (agent side)

- `premature-convergence` — The initial plan used plain functions with per-call `LifecycleDeps`/`ToolStartDeps` interfaces, the first viable approach, without analyzing whether handlers shared collaborators.
  The user had to prompt three times before I switched to class-based handlers with constructor-injected shared deps.
  Impact: three rounds of plan revision before the design was correct; no rework commits, but significant planning churn.

- `instruction-violation` (user-caught) — The `/plan-issue` prompt says "load the `design-review` skill and run its checklist on the affected modules."
  I loaded the skill but did not actually run the checklist (grep for access patterns, check LoD, check output arguments) until the user explicitly told me to "keep digging."
  Had I run the checklist proactively, the output-argument and LoD findings would have surfaced on the first pass, and the predecessor issue (#87) would have been identified without user escalation.
  Impact: user had to escalate three times; planning took ~3× longer than necessary.

- `wrong-abstraction` — I initially reasoned at the mechanical level ("handlers are small, 1–5 lines, so plain functions are fine") instead of the structural level ("do these handlers share collaborators that a class captures naturally?").
  The code-style skill explicitly says "Do not pass a shared dependency bag to functions that only use a subset" — but I applied it backwards (splitting into per-function deps) rather than recognizing the shared deps as a class cohesion signal.
  Impact: same as premature-convergence above; folded into the same rework cycle.

#### What caused friction (user side)

- The progressive escalation approach (question → directive → quote) was effective pedagogically but required three turns of user attention on what a proactive design-review checklist run would have caught automatically.
  Earlier intervention with a specific redirect (e.g., "Run the design-review checklist before writing the plan") could have resolved it in one turn.

### Changes made

1. Retro file created at `packages/pi-subagents/docs/retro/0070-extract-event-handlers.md`.
2. Updated `packages/pi-subagents/docs/architecture/architecture.md` — marked #87 and #70 as done (✓), updated Phase 2 status to complete, updated next-issue pointer to #66.
