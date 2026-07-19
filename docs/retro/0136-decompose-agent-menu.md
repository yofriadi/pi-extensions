---
issue: 136
issue_title: "Decompose `agent-menu.ts`"
---

# Retro: #136 — Decompose `agent-menu.ts`

## Final Retrospective (2026-05-22T20:10:00-04:00)

### Session summary

Decomposed `agent-menu.ts` (668 lines) into four focused modules: `agent-file-ops.ts`, `agent-config-editor.ts`, `agent-creation-wizard.ts`, and a slimmed-down `agent-menu.ts` (296 lines).
Three TDD cycles shipped cleanly, adding 47 tests (714 → 761) and eliminating `vi.mock("node:fs")` from the menu test file.
Released as `pi-subagents-v6.13.0`.

### Observations

#### What went well

- The three-cycle TDD plan (file-ops → config-editor → creation-wizard) produced clean incremental commits with no rework.
  Each cycle left the repo green for both tests and type-check.
- The creation wizard naturally produced narrower interfaces (`WizardManager`, `WizardRegistry`) than the plan specified — a positive deviation from the plan's `AgentTypeRegistry` concrete type, following ISP more strictly.
- The large edit removing ~170 lines of extracted functions from `agent-menu.ts` in Cycle 2 landed correctly on the first attempt, thanks to using exact `oldText` matching with the full function bodies.

#### What caused friction (agent side)

- `missing-context` — The config-editor test factory used `Partial<AgentConfigEditorDeps>` for the overrides parameter.
  The `...overrides` spread created a union type that erased `Mock<...>` methods from `fileOps`, producing 28 `TS2339` errors on `pnpm run check`.
  The testing skill warns about return-type annotations but not about `Partial<Interface>` in overrides — the same erasure mechanism applies through a different path.
  Impact: one extra edit-check cycle to remove the `Partial<>` annotation and overrides parameter.
  Self-identified (caught on `pnpm run check` before commit).

- `missing-context` — The config-editor test had an unused `ctx` variable from an earlier draft of the "disable-only file" test, caught only by the linter after the Cycle 3 commit.
  Impact: required amending the Cycle 3 commit; added friction but no rework.
  Self-identified (caught by `pnpm run lint`).

#### What caused friction (user side)

- None observed — the user's plan was unambiguous and the prerequisite (#135) was already implemented.

### Changes made

1. Added a `Partial<Interface>` type-erasure bullet to `.pi/skills/testing/SKILL.md`.
