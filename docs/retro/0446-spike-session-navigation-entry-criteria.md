---
issue: 446
issue_title: "pi-subagents: spike — resolve ADR-0004 session-navigation entry criteria"
---

# Retro: #446 — pi-subagents: spike — resolve ADR-0004 session-navigation entry criteria

## Stage: Planning (2026-06-20T00:00:00Z)

### Session summary

Planned the Phase 19 Step 1 spike that answers the four ADR-0004 session-navigation entry criteria and records them as an ADR-0004 addendum.
Confirmed the release is independent and that the only committed artifact is the addendum.
The plan lives at `packages/pi-subagents/docs/plans/0446-spike-session-navigation-entry-criteria.md`; next stage is `/build-plan` (docs/spike deliverable, no committed TDD cycles).

### Observations

- Operator owns the issue (`gotgenes` == gh user), so the "Proposed change" is the working hypothesis.
  Used `ask_user` once to resolve two method ambiguities: spike method = **automated observed test (vitest)**, committed artifact = **ADR addendum only** (the vitest harness is throwaway, discarded).
- Gathered the SDK evidence up front so the addendum's expected answers are grounded: `switchSession` is a full active-session takeover that tears down the current runtime via `session_shutdown` (so it threatens the root's in-flight turn); `ReplacedSessionContext` exposes `sendUserMessage` (switch makes the child interactive); `loadEntriesFromFile`/`parseSessionEntries` read entries without switching; `Subagent.outputFile` already exposes the child JSONL path; sibling commands use flat hyphenated names (`agents`, `colgrep-reindex`, `permission-system`).
- Expected recommendations the spike will confirm: read-only `loadEntriesFromFile` transcript (resolves root-continuity by construction), command-first parallel-agent selection (widget gesture deferred), and `/subagents-settings` (reject the ADR's tentative `/subagents:settings`).
- `setBeforeSessionInvalidate` is a **host** runtime seam (`agent-session-runtime`/`interactive-mode`), not on the extension command context — noted in Background so Step 4 does not assume the extension can call it.
- No production code changes and no invariants at risk; the read-only path was chosen partly to keep transcript rendering out of core (preserving the Phase 18 spine invariants from issues #422–#425).

## Stage: Implementation — Build (2026-06-20T10:00:00Z)

### Session summary

Executed the spike: ran a throwaway vitest harness against a real 43-entry child session JSONL, confirmed the read-only transcript path, then wrote the ADR-0004 addendum answering all four entry criteria.
Discarded the harness (operator decision: addendum only) and folded the architecture.md doc-sync into this build rather than deferring it.
Four `docs:` commits; pre-completion reviewer returned WARN, whose findings were then resolved.

### Observations

- **Key divergence from the plan (Finding 0):** the plan's Design Overview assumed `loadEntriesFromFile(path)` would be the read mechanism, but it is **not part of the package's public surface** — it lives in the deep `core/session-manager` module (marked `/** Exported for testing */`) and the public barrel (`src/index.ts` → `dist/index.{d.ts,js}`) re-exports only a curated subset that includes `parseSessionEntries` but not `loadEntriesFromFile`; the `exports` map exposes only `"."`, so the deep import is unsupported too.
  This is **not** a types/runtime mismatch — both barrels agree, and `tsc` rejects the import with `TS2305`.
  My first harness reached a runtime `is not a function` only because Vitest/esbuild strips types without type-checking; `pnpm run check` (`tsc`) would have caught it at compile time.
  My earlier "types/runtime mismatch" framing in the addendum/architecture was wrong and was corrected in a follow-up `docs:` commit.
  Viable path: `parseSessionEntries(readFileSync(outputFile, "utf8"))` (`parseSessionEntries` is public).
- **Upgrade check (operator question):** verified the omission is **not** version-specific — the latest `0.79.8` barrel omits it identically to the pinned `0.79.1`, so an SDK bump does not surface `loadEntriesFromFile`.
  No upgrade pursued (out of scope for a docs-only spike); noted the routine `0.79.1` → `0.79.8` freshness gap as a separate, unrelated item.
- **Doc-sync landed now, not deferred:** the reviewer flagged architecture.md line 997 ("Mechanism (confirmed by Step 1): `switchSession` … or `loadEntriesFromFile`") as actively contradicting the spike.
  Since the spike now exists, I marked Step 1 ✅ (heading + Mermaid node `S1`), corrected the Phase 18 summary line, and rewrote the Step 4 mechanism line to `parseSessionEntries(readFileSync(...))` — closing the WARN.
- **Pre-completion reviewer: WARN** (no FAILs) — three architecture.md staleness findings, all addressed in the final `docs:` commit (`74e2374f`).
  No `src/`/`test/` changes; `pnpm run check` + `pnpm run lint` + `pnpm fallow dead-code` all green at baseline and after.
- Release recommendation unchanged: **ship independently** (`Release: independent`).

## Stage: Final Retrospective (2026-06-20T18:00:00Z)

### Session summary

Planned, built, and shipped the Phase 19 Step 1 spike across three workflow stages, producing the ADR-0004 addendum that answers all four session-navigation entry criteria and unblocks #445.
The spike did its job — it rejected ADR-0004's literally-named `loadEntriesFromFile` mechanism before Step 4 coded against it — but the build stage committed an incorrect "types/runtime mismatch" characterization that took two user questions and a correction commit to fix.
Eight `docs:` commits landed; no release (all `docs:`, auto-batched).

### Observations

#### What went well

- **The spike paid for itself, then over-delivered.**
  It caught that ADR-0004's named candidate (`loadEntriesFromFile`) is not in the SDK's public surface — a finding about the *implementation*, not the harness — before Step 4 started.
  The operator's three follow-up questions (upgrade?
  describe-the-mismatch?
  spike-vs-implementation impact?) then drove the addendum from a thin "use `parseSessionEntries`" note into a complete, link-backed render pipeline (Finding 1: `parseSessionEntries` → `buildSessionContext` → Pi's public entry components / `serializeConversation`).
  Step 4 now starts from a verified, public-API-only design.
- **Clean, non-defensive self-correction.**
  When the operator asked me to substantiate the claim with links (turn 74), running the actual `tsc` probe surfaced my own error; I corrected all three artifacts (addendum, `architecture.md`, retro) in commit `112c4254` without hedging.
  "Ask the agent to cite/substantiate a claim" proved a high-leverage verification gesture.

#### What caused friction (agent side)

- `wrong-abstraction` (compounded by `missing-context`) — I diagnosed a question about the SDK's *export surface* from a *runtime* symptom.
  The throwaway vitest harness threw `loadEntriesFromFile is not a function`, and I leapt to the dramatic reading ("declared in `.d.ts` but absent at runtime — a types/runtime mismatch") instead of running `tsc`, which disambiguates instantly (`TS2305: has no exported member`).
  The symbol is simply not in the public barrel — types and runtime agree.
  Impact: an incorrect technical claim shipped into three committed artifacts (addendum `7c505b78`, `architecture.md`, the build retro note) and required a 3-file correction commit (`112c4254`) plus two operator questions to surface and fix.
- `instruction-violation` (user-caught) — the `testing` skill already states "Vitest uses esbuild and does not typecheck; run `pnpm run check`."
  I never ran `tsc` against the harness or the export claim during the build.
  Two reasons it slipped: (1) the skill was not loaded — `/build-plan` only loads `testing` "if the plan involves test changes or TDD steps," and a docs-only spike using a throwaway harness does not obviously match; (2) the existing rule is framed for "type-only changes," not for *claims/findings about what a module exports*, so it would not clearly have fired even if loaded.
- `other` (tooling friction, minor) — getting the `tsc` probe to resolve the package took four attempts (turns 77–80: `npx` blocked → `pnpm exec` → files-on-cmdline tsconfig error → probe-inside-package).
  Impact: added friction, no rework; not a conceptual rabbit-hole.

#### What caused friction (user side)

- None material — the operator's three interventions were strategic probes (dependency-freshness, claim substantiation, spike-vs-implementation scope) that each improved the artifact.
  The only "earlier" opportunity is an agent-side gap: I should have self-applied the `tsc` check so the operator did not need to ask "describe the mismatch" to trigger verification.

### Diagnostic details

- **Model-performance correlation** — Planning + Build + the correction work all ran on `anthropic/claude-opus-4-8` (turns 2–104); the mischaracterization therefore occurred on the *strong* model, so the fix is process (run `tsc` on export claims), not model selection.
  The Ship stage (turns 106–122) ran on `opencode-go/deepseek-v4-flash` — appropriate cost-matching for a mechanical git/CI/close procedure, which it executed cleanly.
  A transient `anthropic/claude-sonnet-4-6` `model_change` carried no assistant turn (never ran).
- **Escalation-delay tracking** — no rabbit-hole exceeded five consecutive tool calls on one error; the runtime `is not a function` was resolved in ~2 calls (the issue was the *interpretation*, not a stuck loop).
- **Unused-tool detection** — for the mischaracterization, `tsc` / `pnpm run check` was available and routine but applied only at baseline (turn 29) and not again until the operator forced it (turns 77–80); it was never run against the harness or the claim.
- **Feedback-loop gap analysis** — `pnpm run lint` ran after every doc edit (good incremental hygiene), but the *type-check* loop was skipped for precisely the finding that needed it — the harness ran under vitest (no typecheck) and `tsc` was not run on the export claim before committing it.

### Changes made

1. Extended the `testing` skill's `## Type checking` section to cover verifying claims about module exports with `tsc`, not runtime symptoms — `Refs #446`.
   File: `.pi/skills/testing/SKILL.md`.
