---
issue: 262
issue_title: "Add WorkspaceProvider extension seam"
---

# Retro: #262 — Add WorkspaceProvider extension seam

## Stage: Planning (2026-05-29T14:51:15Z)

### Session summary

Produced a numbered implementation plan for the Phase 16, Step 2 `WorkspaceProvider` seam ([ADR-0002]).
The plan adds the seam additively — `WorkspaceProvider` / `Workspace` interfaces, `SubagentsService.registerWorkspaceProvider`, run-start consultation, and `dispose` with a verbatim `resultAddendum` — while leaving the existing `isolation: "worktree"` path untouched for #263 to evict.
Three TDD steps (two `feat`, one `docs`).

### Observations

- Two ambiguous choices were surfaced via `ask_user` and resolved: **scope = additive seam only** (Option A — leave the legacy worktree path; #263 evicts it), and **duplicate registration = throw** (loud misconfiguration surface, disposer clears only the active provider).
- The package's public surface is `./src/service.ts` (per `package.json` `exports`), so the seam types are defined in a new core `src/lifecycle/workspace.ts` and re-exported from `service.ts` — avoiding a `service ↔ lifecycle` import cycle while still exposing them to the worktrees consumer.
- Diverged from the issue's literal `Disposable` return type: the repo convention for unsubscribe/unregister is a plain `() => void` (matching `SubscribableSession.subscribe` and `pi.events.on`); no `Symbol.dispose` usage exists anywhere in the codebase.
- Provider-first precedence was chosen so the new seam and the legacy worktree collaborator never silently conflict during the transient dual-path window (#263 collapses the branch).
- Headline risk is the ADR "no vacant hooks" rule: within #262 the seam is exercised only by test fakes, so it must land **alongside** #263 (`@gotgenes/pi-subagents-worktrees`) and not ship in a release on its own.
- Step 1 bundles the entire registration surface (types, `SubagentsService` method, adapter impl, `AgentManagerLike`, required `baseCwd`) into one commit because the interface method forces the adapter and the required field forces both construction sites — splitting would not type-check.
- Verified `test/service/service.test.ts` casts its mock `as unknown as SubagentsService`, so adding an interface method does not break it; flagged the `createManager` and `AgentManagerLike` mock updates for the `baseCwd` and registration additions.

## Stage: Implementation — TDD (2026-05-29T15:09:49Z)

### Session summary

Implemented the `WorkspaceProvider` seam across three TDD cycles (two `feat`, one `docs`): the registration surface (`AgentManager.registerWorkspaceProvider` + service/adapter delegation + `workspace.ts` types), run-start consumption in `Agent.run()` with provider-first precedence and `dispose`/`resultAddendum`, and an architecture-doc update.
Test count went from 1049 to 1061 (+12 new tests; +6 in `agent.test.ts`, +4 registration in `agent-manager.test.ts`, +1 adapter delegation, plus existing-helper additions).
All deterministic gates green: `check`, `lint`, `test`, and `fallow dead-code` (run from repo root).

### Observations

- Deviation from plan (Module-Level Changes): the plan said `service.ts` would re-export "the five seam types and `AgentStatus`", but `fallow dead-code` flagged those five re-exports as unused (no consumer until #263), and AGENTS.md forbids speculative re-exports.
  Resolved by re-exporting only `WorkspaceProvider` — a consumer assigning to it gets `Workspace` and the context types via inference; #263 adds named re-exports when it imports them.
  This is the concrete manifestation of the plan's headline "vacant hook" risk surfacing in the dead-code gate.
- Lint surprise: `WorkspaceDisposeResult | void` tripped eslint `no-invalid-void-type`.
  Changed the `dispose` return type to `WorkspaceDisposeResult | undefined` (equivalent — a side-effecting `dispose` that falls off the end returns `undefined`); minor divergence from the issue's literal `| void`.
- Three test mock factories implement `AgentManagerLike` in `service-adapter.test.ts` (`createMockManager`, `defaultManager`, `createTestManager`) — all three needed the new `registerWorkspaceProvider` stub; `tsc` caught the third after the first two were updated.
- Used `git commit --fixup` + `--autosquash` rebase twice (unpushed history) to fold the fallow trim into the Step 1 `feat` commit and the reviewer's doc-wording fix into the Step 3 `docs` commit, keeping each commit self-consistent.
- Pre-completion reviewer: WARN — all blocking checks pass; one non-blocking doc finding (architecture.md overstated that `Workspace` is re-exported).
  Addressed before finishing.

## Stage: Final Retrospective (2026-05-29T15:40:54Z)

### Session summary

Shipped #262: pushed, CI green, closed the issue, and merged release-please PR #269 → `pi-subagents-v11.5.0`.
Mid-session the user asked what `model: claude-sonnet-4-6-20260526` in `.pi/agents/pre-completion-reviewer.md` resolved to; investigation found it had no entry in Pi's model registry and was silently falling back to the parent session model, and the fix (`anthropic/claude-sonnet-4-6`) landed in `1e46c5f4`.
Across all stages the plan's risk predictions held and TDD verification was incremental.

### Observations

#### What went well

- The planning-stage "vacant hook" risk prediction manifested exactly as predicted at the `fallow dead-code` gate: the plan named the failure (speculative re-exports flagged dead) before it happened, and the fix (re-export only `WorkspaceProvider`) was already reasoned out — a clean closed loop from planning risk to implementation gate.
- Incremental verification during TDD: `check` / `test` / `lint` ran after each step plus per-file vitest red→green, not just at the end.
- The model-spec question surfaced and fixed a latent silent bug — the reviewer's configured `model:` had no registry entry and was inheriting the parent model, so the misconfiguration produced no error.
- Cost discipline: the session model was switched to `opencode-go/deepseek-v4-flash` for the mechanical shipping stage — appropriate model-to-task matching.

#### What caused friction (agent side)

- `rabbit-hole` — the model-resolution investigation (≈30 tool calls, turns 119–160) grepped the Pi core monorepo (`~/development/pi/pi/packages/coding-agent`) for `.pi/agents/` frontmatter handling that does not live there, before landing on `pi-prompt-template-model/model-selection.ts` (a `pi-packages` dependency) plus the `models.generated.ts` registry.
  Impact: long detour on a user tangent; no rework, but the answer was reachable far sooner.
- `other` (minor, recurring) — the pre-commit `trim trailing whitespace` hook reformatted files on the first `git commit`, failing it; the immediate retry succeeded (turns 55→56 and 95→96).
  Impact: one wasted commit attempt per occurrence, no rework.

#### What caused friction (user side)

- The broken model spec was pre-existing config; because the failure mode is a silent fallback, such typos never surface on their own.
  Opportunity (not criticism): a short convention note so future `.pi/agents/*.md` authoring uses the registry-resolvable `provider/id` form.

### Diagnostic details

- **Model-performance correlation** — the `pre-completion-reviewer` subagent was dispatched (turn 90) while the parent model was `anthropic/claude-opus-4-8`; because its `model:` frontmatter did not resolve, it ran on opus-4-8 (strong reasoning, appropriate for judgment-heavy review) rather than the configured Sonnet.
  No quality mismatch in outcome, but the risk was latent: a weaker parent model would have silently degraded the reviewer.
  The shipping stage ran on `deepseek-v4-flash` (mechanical git/CI/release ops) — appropriate.
- **Escalation-delay tracking** — the model-resolution `rabbit-hole` ran ≈30 consecutive search calls on the same goal, far past the 5-call threshold; consulting the `prompt-template-authoring` skill or reading `model-selection.ts` first would have shortcut it.
- **Unused-tool detection** — for that investigation the `prompt-template-authoring` skill (documents template/agent `model:` format) and `code_search` were available but not used; grep over two monorepos was used instead.
- **Feedback-loop gap analysis** — none; verification ran incrementally after each TDD step, not only at the end.

### Changes made

1. `AGENTS.md` (Pre-completion reviewer subsection) — added a one-line guardrail: agent `model:` frontmatter must use the `provider/id` alias form the Pi CLI/UI accepts, because an ID absent from the model registry silently falls back to the parent session model.
2. `packages/pi-subagents/docs/retro/0262-add-workspace-provider-seam.md` — this Final Retrospective stage entry.

[ADR-0002]: ../decisions/0002-extensions-on-a-minimal-core.md
