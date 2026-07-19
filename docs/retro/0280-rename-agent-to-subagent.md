---
issue: 280
issue_title: "Rename the internal Agent class to Subagent"
---

# Retro: #280 — Rename the internal `Agent` class to `Subagent`

## Stage: Planning (2026-05-31T00:09:51Z)

### Session summary

Produced a numbered implementation plan to rename the subagent-instance cluster in `src/lifecycle/` from the bare `Agent*` family to `Subagent*`, consolidate the duplicate `AgentStatus` union into the public `SubagentStatus`, and update the architecture doc.
The plan is a 7-step refactor (no behavior change), each step an atomic language-service rename that leaves the tree green.

### Observations

- Scope decisions confirmed with the user via `ask_user`: (1) rename the module files too (`agent.ts` → `subagent.ts`, `agent-manager.ts` → `subagent-manager.ts`, plus test/helper files), and (2) full-consistency rename of adjacent identifiers — `subscribeAgentObserver`, the `SubagentManagerObserver` `onAgent*` methods, and the `createTestAgent` helper.
- Layering catch: pointing `WorkspaceDisposeOutcome.status` directly at `service.ts`'s `SubagentStatus` would create a `lifecycle → service` cycle (`service.ts` already imports the workspace collaborator types).
  Resolution: keep the union's single home in the lifecycle layer (`subagent.ts`) and have `service.ts` re-export it, mirroring the existing `LifetimeUsage` / workspace re-export pattern.
- Acceptance-grep catch: the issue's `grep src/lifecycle/` for bare `Agent` matches comments and string literals (e.g. the two `"Agent not configured …"` error messages), not just symbols.
  The language-service rename does not touch those, so each step must sweep residual comment/string occurrences; step 7 has a final grep gate.
- Compound names (`AgentSession`, `AgentInvocation`, `AgentTypeRegistry`, `AgentTool`, `AgentSpawnConfig`) are not bare-word matches and are explicitly out of scope.
- Non-breaking — `refactor:` commits throughout; `verify:public-types` runs after the status consolidation and the final step since the public bundle (`dist/public.d.ts`) is rolled from `src/service/service.ts`.
- Also flagged the `package-pi-subagents` SKILL.md for an internals-naming update (it references `AgentManager`, `Agent`, `make-agent`).

## Stage: Implementation — TDD (2026-05-31T00:38:55Z)

### Session summary

Completed 6 refactor commits (steps 1–6 from the plan, with step 5 folded into step 3) plus a `test:` commit for the helper rename and a `docs:` commit for the architecture doc update.
All 973 tests pass across 59 test files with no test count delta.
Pre-completion reviewer returned PASS with all 5 acceptance criteria verified.

### Observations

- Step 5 (`AgentManagerLike` → `SubagentManagerLike`) was automatically folded into step 3 because the bulk-rename Python script replaced all `AgentManager*` compounds at once — no separate commit was needed or appropriate.
- The acceptance grep (`grep -rnE '\bAgent(Manager|Init)?\b' src/lifecycle/`) also flags bare `Agent` in comments and error strings; each rename step swept those manually since the language-service rename does not touch non-symbol text.
- `sed` with negative lookaheads failed on macOS for the `notification.ts` file; fell back to a two-pass approach (sed for the import, then `perl -i -0pe` with negative lookahead for the body).
- `describe("Agent — ...)` test block names used em-dashes (Unicode U+2014); `sed` with `\u2014` escape did not match on macOS — required Python `re.sub` with the literal character.
- The `SubagentStatus` type definition was kept in `src/lifecycle/subagent.ts` (single home) and re-exported from `src/service/service.ts`, matching the existing `LifetimeUsage` / workspace re-export pattern and avoiding a `lifecycle → service` cycle.
- Docs: the architecture doc's session-encapsulation table had misaligned Markdown table columns after the rename (cell widths changed); `rumdl fmt` auto-fixed them.
- Pre-completion reviewer: PASS — all deterministic checks, all 5 acceptance criteria, conventional commits, docs, Mermaid diagrams, and dead-code gate confirmed clean.

## Stage: Final Retrospective (2026-05-31T01:05:57Z)

### Session summary

Shipped the full Planning → TDD → Ship lifecycle for the internal `Agent` → `Subagent` rename across `@gotgenes/pi-subagents`: 7 implementation commits (6 `refactor:`/`test:` + 1 `docs:`), 973 tests green throughout, CI passed on `27abb5aa`, and issue #280 closed.
No release was triggered (all `refactor:`/`test:`/`docs:` commits), so no release-please PR appeared — expected.

### Observations

#### What went well

- Two planning-stage catches prevented downstream rework: the `lifecycle → service` import cycle (resolved by keeping `SubagentStatus`'s single home in `subagent.ts` and re-exporting from `service.ts`) and the acceptance grep matching bare `Agent` in comments/strings (so each step swept non-symbol text).
  Both were anticipated in the plan and held during execution.
- Incremental verification carried the rename safely: `pnpm run check` plus the affected test files ran after every step, so the text-based substitution mistakes were caught instantly and never reached a commit.
  The pre-completion reviewer then returned a clean PASS with nothing to fix.
- The status re-export needed a follow-up `import type { SubagentStatus }` because `export type { … } from` does not create a local binding for `SubagentRecord` to reference — `pnpm run check` flagged it immediately, a one-edit fix.

#### What caused friction (agent side)

- `wrong-abstraction` — The plan specified each rename as a "scope-aware language-service pass" (`findRenameLocations`), but the execution toolkit has no LSP-rename tool — only `Edit`, `Bash` (`sed`/`perl`/`python`), and `grep`.
  Execution fell back to text substitution, which is exactly why the comment/string sweep was needed and why the regex gymnastics below happened.
  Impact: added friction but no rework — `tsc` + tests caught every gap; no incorrect commit landed.
- `other` (cross-platform tooling) — Repeated silent failures from BSD `sed` / `perl` one-liners: BSD `sed` lacks `\b` and lookahead; `perl -i ''` is malformed (the `-i ''` form is a `sed`-ism); neither interprets `\uXXXX` escapes, so em-dash `describe("Agent — …")` blocks and `notification.ts` body renames did not match.
  Each failure forced a grep-verify-redo loop, ultimately resolved by switching to Python `re.sub`.
  Impact: roughly 5–8 extra tool calls across the TDD stage; no rework beyond the redo cycles.

#### What caused friction (user side)

- None.
  The user's two `ask_user` answers at planning time (file renames + full-consistency adjacent identifiers) front-loaded every scope decision, so the TDD and Ship stages ran without a single mid-course correction.

### Diagnostic details

- **Model-performance correlation** — One subagent dispatched (`pre-completion-reviewer`) on judgment-heavy review work (acceptance verification, Mermaid validation via `mmdc`, dead-code gate); appropriate match, no mismatch.
- **Escalation-delay tracking** — The `notification.ts` body rename cycled ~4–5 consecutive `sed`/`perl`/`grep` calls on the same substitution before switching to `perl -i -0pe`; under the 5-call threshold but the closest the session came.
  The general lesson (prefer Python `re.sub`) generalizes the fix.
- **Unused-tool detection** — No Explore/`colgrep` gap: the codebase was already understood from planning, and an exact symbol rename is not a semantic-search task.
  The only "missing capability" is a language-service rename tool, which is not in the toolkit — a genuine gap, not an unused option.
- **Feedback-loop gap analysis** — No gap: `pnpm run check` and affected tests ran after each step (incremental); `pnpm run lint`, `pnpm fallow dead-code`, and `verify:public-types` ran as the final batch.
  Verification cadence was correct.

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-subagents/docs/retro/0280-rename-agent-to-subagent.md`.
2. Strengthened the global `APPEND_SYSTEM.md` "Shell Commands" rule to name the literal absolute-path `cd` form (e.g. `cd /Users/you/project &&`), not just `cd $CWD &&` — the existing rule failed to catch the literal-path form that agents actually emit.
   This file is global (`~/.pi/agent/APPEND_SYSTEM.md`), outside the repo, so it is not committed here.
3. Added a monorepo-specific line to `AGENTS.md` § Monorepo Structure: prefer `pnpm --filter @gotgenes/<pkg> run <script>` (or `pnpm -C packages/<pkg> run <script>`) from the root over `cd packages/<pkg> && pnpm run <script>`.
   Prompted by excessive `cd` chaining observed across this session's Ship and Retro stages.

### Follow-ups considered (not applied)

1. Proposed adding a bulk-substitution tooling rule (prefer Python `re.sub` over `sed`/`perl` one-liners, since BSD `sed` lacks `\b`/lookahead and `\uXXXX` is uninterpreted) to the `code-design` skill's Tooling section.
   The user opted to record the observation here only and skip the skill change.
