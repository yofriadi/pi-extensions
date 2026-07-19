---
issue: 536
issue_title: "pi-subagents Phase 20 Step 2: decompose get-result-tool.execute"
---

# Decompose `get-result-tool.execute` into a pure report formatter

## Release Recommendation

**Release:** ship now — batch "result-delivery" tail (this issue completes the batch)

This is Phase 20 Step 2, the tail of the `result-delivery` batch (Steps 1 + 2), per the architecture roadmap's `Release batches` subsection ("Batch 'result-delivery': Steps 1, 2; tail = Step 2").
Step 1 ([#535]) already landed as `refactor:` commits held back from release under a `mid-batch — defer` marker.
This step lands the batch, so the release-please PR — carrying both Step 1 and Step 2 — should be merged at ship time.
The commits here are also `refactor:`/`docs:` (hidden/unhidden changelog types); the batch ships together into the next release.

## Problem Statement

`GetResultTool.execute` is 61 lines and 15 cyclomatic — the highest-complexity function remaining in `src/` (CRAP 63.6).
It fuses three concerns: wait/consume policy (look up the record, consume before awaiting, consume on settle), stats-line formatting (the conditional `statsParts` pushes), and output-body assembly (header + per-status body + optional conversation).
The stats and body assembly are pure string transforms and belong in a testable formatter alongside the existing `result-renderer.ts` pattern in `src/tools/`, leaving `execute` a thin shell that owns only the wait/consume policy.

## Goals

- Extract the report assembly (header line, stats parts, per-status body, optional verbose conversation) from `execute` into a pure formatter module, `src/tools/get-result-report.ts`, unit-tested directly.
- Reduce `GetResultTool.execute` to a thin shell (≤ 30 lines, cyclomatic < 10) that owns only record lookup and the wait/consume policy, delegating all text assembly to the formatter.
- Keep the extracted formatter's input a narrow value object (`AgentReport`) that lists only the fields it reads (ISP), so it is testable over primitives without a `Subagent` or a registry.
- Take `get-result-tool.execute` off the fallow HIGH-CRAP list (CRAP ≥ 60: 3 src functions → 2).

This change is **not breaking** — it is an internal refactor.
The `get_subagent_result` tool's observable output (header lines, stats ordering, per-status body, verbose conversation block) is byte-identical, and the consume/wait behavior is unchanged.

## Non-Goals

- Any change to `execute`'s wait/consume policy or the double-consume in the wait path — it is preserved exactly (see Design Overview / Invariants at risk).
- Decomposing the notification renderer (`src/observation/renderer.ts`, CRAP 79.4) — that is Phase 20 Step 7 ([#541]).
- Typing the model boundary or `service-adapter.spawn` (CRAP 71.3) — that is Phase 20 Step 4 ([#538]).
- Touching `src/tools/result-renderer.ts` (the UI/`Theme` widget renderer for the `subagent` tool) — the new module sits *alongside* it but shares no code; the two render different surfaces (colored TUI widget vs. plain tool-result text).

## Background

`src/tools/get-result-tool.ts` holds `GetResultTool` (constructed with a `GetResultToolManager`, a `GetResultToolNotifications`, and an `AgentConfigLookup` registry).
`execute` today:

1. `manager.getRecord(agent_id)` → early not-found `textResult`.
2. If `wait && status === "running" && promise`: `notifications.consume(id)` then `await record.promise` (the pre-await consume, preserving the "Bug 1" ordering from Step 1).
3. Build `displayName` (`getDisplayName(record.type, registry)`), `duration` (`formatDuration(record.startedAt, record.completedAt)`), `tokens` (`formatLifetimeTokens(record)`), `contextPercent` (`record.getContextPercent()`), then assemble `statsParts` and the header + per-status body.
4. Terminal consume: `if (status !== "running" && status !== "queued") notifications.consume(id)`.
5. If `verbose`: append `record.getConversation()` under an `--- Agent Conversation ---` header.
6. `return textResult(output)`.

Collaborators the formatter's inputs derive from:

- `src/ui/display.ts` — `getDisplayName(type, registry)`, `formatDuration(startedAt, completedAt)` (both pure).
- `src/tools/helpers.ts` — `formatLifetimeTokens(record)` (pure; `""` when zero) and `textResult(msg)`.
- `src/lifecycle/subagent.ts` — `Subagent` getters `id`, `type`, `description`, `status`, `result`, `error`, `toolUses`, `startedAt`, `completedAt`, `compactionCount`, `promise`, `getContextPercent()`, `getConversation()`.
- `SubagentStatus` is defined in `#src/lifecycle/subagent-state` and re-exported from `#src/lifecycle/subagent`.

The existing `src/tools/result-renderer.ts` is the precedent: a stateless module of pure formatters (`renderStats`, per-status `renderRunning`/`renderCompleted`/…) each returning a string, consumed by one caller.
This step mirrors that shape for the `get_subagent_result` text report.

Constraint from AGENTS.md: this package ships source directly but carries type-declaration bundles for two public entries.
`get-result-tool.ts` and the new `get-result-report.ts` are internal (not on any public `exports` subpath), so no `verify:public-types` or rollup change is required.
`pnpm fallow dead-code` gates in CI: the new formatter must be wired into `execute` in the **same commit** it is added, or its unused export trips the dead-code check.

## Design Overview

Split the three fused concerns cleanly:

- **wait/consume policy** stays in the shell (`execute`).
- **stats-line formatting** + **output-body assembly** move to the pure formatter.

### New module: `src/tools/get-result-report.ts`

A narrow value object plus pure assembly functions (mirroring `result-renderer.ts`'s export-the-pieces style):

```typescript
import type { SubagentStatus } from "#src/lifecycle/subagent";

/** The data a get_subagent_result report renders from — only what the formatter reads. */
export interface AgentReport {
  id: string;
  displayName: string;
  status: SubagentStatus;
  toolUses: number;
  /** Pre-formatted lifetime token total; "" when zero. */
  tokens: string;
  contextPercent: number | null;
  compactionCount: number;
  /** Pre-formatted duration string. */
  duration: string;
  description: string;
  result: string | undefined;
  error: string | undefined;
  /** Present only when verbose was requested and a conversation is available. */
  conversation?: string;
}

/** Assemble the stats parts: Tool uses / tokens? / Context? / Compactions? / Duration. */
export function renderStatsParts(report: AgentReport): string[] {
  const parts = [`Tool uses: ${report.toolUses}`];
  if (report.tokens) parts.push(report.tokens);
  if (report.contextPercent !== null) parts.push(`Context: ${Math.round(report.contextPercent)}%`);
  if (report.compactionCount) parts.push(`Compactions: ${report.compactionCount}`);
  parts.push(`Duration: ${report.duration}`);
  return parts;
}

/** Select the per-status body: running note, error line, or trimmed result. */
export function renderReportBody(report: AgentReport): string {
  if (report.status === "running")
    return "Agent is still running. Use wait: true or check back later.";
  if (report.status === "error") return `Error: ${report.error}`;
  return report.result?.trim() ?? "No output.";
}

/** Assemble the full get_subagent_result report text. */
export function formatAgentReport(report: AgentReport): string {
  let output =
    `Agent: ${report.id}\n` +
    `Type: ${report.displayName} | Status: ${report.status} | ${renderStatsParts(report).join(" | ")}\n` +
    `Description: ${report.description}\n\n`;
  output += renderReportBody(report);
  if (report.conversation) {
    output += `\n\n--- Agent Conversation ---\n${report.conversation}`;
  }
  return output;
}
```

Every line is a byte-for-byte transcription of today's inline assembly (same separators, same `Math.round`, same `?? "No output."`, same conversation header), so the rendered output is unchanged.

### Shell after extraction

`execute` gathers the report data (via the existing pure helpers + record getters) and delegates:

```typescript
async execute(_id, params, _signal, _onUpdate, _ctx) {
  const record = this.manager.getRecord(params.agent_id);
  if (!record) {
    return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
  }
  // Consume BEFORE awaiting: preserves the Step 1 "Bug 1" ordering.
  if (params.wait && record.status === "running" && record.promise) {
    this.notifications.consume(params.agent_id);
    await record.promise;
  }
  // Consume the settled result — suppresses the completion notification.
  if (record.status !== "running" && record.status !== "queued") {
    this.notifications.consume(params.agent_id);
  }
  return textResult(formatAgentReport(this.buildReport(record, params.verbose)));
}

private buildReport(record: Subagent, verbose?: boolean): AgentReport {
  return {
    id: record.id,
    displayName: getDisplayName(record.type, this.registry),
    status: record.status,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    contextPercent: record.getContextPercent(),
    compactionCount: record.compactionCount,
    duration: formatDuration(record.startedAt, record.completedAt),
    description: record.description,
    result: record.result,
    error: record.error,
    conversation: verbose ? record.getConversation() : undefined,
  };
}
```

`buildReport` stays a private method on the class because it reads `this.registry`; it is the one place record getters + registry lookup are gathered (a single Law-of-Demeter hop, no reach-through).
`execute` drops to ~12 lines and cyclomatic well under 10.

### Ordering note (behavior-preserving)

Today the terminal consume runs *after* the header/body are assembled but *before* the verbose conversation is appended.
Consume is a side effect on `notifications`; output building only *reads* the record.
Moving the terminal consume ahead of `buildReport` is therefore behavior-neutral, and it keeps the shell's two consume sites adjacent to the wait policy they belong with.
Both consume calls are retained exactly: in the `wait && running` path the pre-await consume fires, then after the await the record is settled so the terminal consume fires again — an idempotent double-consume (Set add + cancel-nudge), unchanged from today.

### Design-review checklist (applied)

- **Dependency width / ISP** — `AgentReport` carries 12 fields; `formatAgentReport` + its two helpers read every one, so the value object is not over-wide.
  It deliberately does *not* carry the full `Subagent` (which exposes ~30 members), so the formatter depends only on what it renders.
- **Law of Demeter** — the formatter receives primitives, no chained access.
  The shell's `buildReport` performs the record-getter reads in one place; `getDisplayName(record.type, registry)` is the only two-arg helper and is already the established seam.
- **Tell-Don't-Ask** — the formatter is a data→string transform (no collaborator to tell); the consume tell (`notifications.consume(id)`) stays in the shell, unchanged from Step 1.
- **No output arguments / no scattered resets** — the formatter returns a value; it mutates nothing.
- **No new repeated discriminator** — the `status === "running"` / `"error"` branch is centralized in `renderReportBody`; it does not add a new site of an existing cross-module comparison.

## Module-Level Changes

- `src/tools/get-result-report.ts` — **new**.
  `AgentReport` interface + `renderStatsParts`, `renderReportBody`, `formatAgentReport` pure functions.
- `src/tools/get-result-tool.ts` — remove the inline stats/header/body/conversation assembly from `execute`; add the private `buildReport(record, verbose)` method; `execute` delegates to `formatAgentReport`.
  Imports: add `formatAgentReport` + `AgentReport` from `./get-result-report` (and `SubagentStatus` is only needed in the new module); the `getDisplayName`/`formatDuration`/`formatLifetimeTokens`/`textResult` imports remain (now used by `buildReport`).
- `test/tools/get-result-report.test.ts` — **new**.
  Direct unit tests for the pure formatter (see TDD Order).
- `test/tools/get-result-tool.test.ts` — keep the shell/integration tests (not-found, consume policy, wait, one representative body per status, verbose wiring); no exhaustive stats/body permutations here (those move to the formatter test).
  No structural rewrite — the public `GetResultTool` surface and its constructor are unchanged, so existing tests stay green as-is.
- `docs/architecture/architecture.md` — add the `get-result-report.ts` entry to the `tools/` module tree (after `result-renderer.ts`); flip the Step 2 heading to `#### ✅ Step 2 — …` and add a `Landed:` bullet; tick the Phase 20 roadmap Mermaid node `S2` (line ~1068) to `✅`; update the discovery-finding-4 prose (line ~921) noting `get-result-tool.execute` is now off the HIGH-CRAP list (3 → 2 remaining: `service-adapter.spawn`, the renderer arrow).
  Leave the Phase 20 target table's `src functions with CRAP ≥ 60` **target** column at `0` (phase-end target, reached after Steps 4 + 7).
- `.pi/skills/package-pi-subagents/SKILL.md` — bump the Tools domain row module count (8 → 9) and add `get-result-report` to its module list; bump the "seven domains (N files)" total (56 → 57).

Grep sweep performed for touch-points (no other references found): `get-result-tool` / `GetResultTool` appears in `architecture.md` (module tree line 336; pull-query tables lines 715/717 — those cite `getConversation`/`getContextPercent`, unaffected by this refactor) and the SKILL Tools row; no README command entry names the internal module (the README documents the `get_subagent_result` tool, whose behavior is unchanged).

## Test Impact Analysis

1. **New tests enabled** — `formatAgentReport` (and `renderStatsParts` / `renderReportBody`) become directly unit-testable over primitives, without constructing a `Subagent` or an `AgentConfigLookup`.
   Previously the stats-permutation logic (tokens present/absent, `contextPercent` null vs. a value, `compactionCount` zero vs. non-zero) and the body selection (running / error / completed-with-result / completed-no-output / verbose-append) were reachable only by building a record and running the full `execute`.
   The new tests pin each permutation cheaply and exhaustively.
2. **Redundant tests** — the existing `get-result-tool.test.ts` cases that assert body text ("returns status and result", "shows running message", "shows error") become light integration duplicates of the formatter unit tests.
   Keep one representative per status as a shell-wiring smoke, but do not expand stats/body coverage in this file — the permutation matrix lives in `get-result-report.test.ts`.
3. **Tests that stay** — everything exercising the shell's policy, which the formatter cannot cover: not-found lookup, "consumes for a completed agent with/without a toolCallId", "does not consume for a running agent", "waits for promise when wait=true", and "includes conversation when verbose=true" (the last verifies `buildReport` threads `record.getConversation()` into the report).

## Invariants at risk

This step touches the `get-result-tool` surface that Step 1 ([#535]) refactored.
Step 1's documented outcome and the invariants it pinned must survive:

- **Pre-await consumption ("Bug 1" ordering)** — consuming before awaiting suppresses the completion nudge.
  Pinned by the "Bug 1 race condition" describe block in `test/lifecycle/subagent-manager.test.ts` (migrated in Step 1 to assert suppression through the manager) and by `get-result-tool.test.ts`'s consume/wait tests.
  The shell keeps both consume sites and their order; do not fold them.
- **Single `consume(id)` tell (Step 1 outcome)** — the tool calls `notifications.consume(id)`, never a reach-through into the record.
  The refactor keeps both `this.notifications.consume(...)` calls verbatim; `buildReport` reads record getters only, adds no `record.notification?.` access.
- **Byte-identical `get_subagent_result` output** — header lines, stats ordering/separators, per-status body, and the verbose block must render identically.
  Pinned by the retained `get-result-tool.test.ts` body/verbose assertions plus the new `formatAgentReport` character-level tests.

## TDD Order

1. **Extract the pure report formatter and rewire the shell** (single atomic refactor step).
   The formatter must be wired into `execute` in the same commit it is added — an added-but-unwired export trips `pnpm fallow dead-code` (a CI gate).
   - Red: add `test/tools/get-result-report.test.ts` asserting `formatAgentReport` output for: the full header (`Agent:` / `Type: … | Status: … | Tool uses: … | Duration: …`); stats permutations via `renderStatsParts` (tokens omitted when `""`; `Context: N%` omitted when `contextPercent` is null and rounded when present; `Compactions: N` omitted when zero); `renderReportBody` per status (running note, `Error: …`, trimmed result, `"No output."` when result is undefined); and the verbose `--- Agent Conversation ---` append (present when `conversation` set, absent otherwise).
     Fails — `get-result-report.ts` does not exist.
   - Green: create `src/tools/get-result-report.ts` (`AgentReport` + `renderStatsParts` + `renderReportBody` + `formatAgentReport`); refactor `GetResultTool.execute` to gather via the new private `buildReport` and delegate to `formatAgentReport`; adjust `test/tools/get-result-tool.test.ts` only if wording assertions shift (they should not — output is identical).
   - Verify: `pnpm --filter @gotgenes/pi-subagents run check && … run lint && … run test`, then `pnpm fallow dead-code` (confirms no unused export and that `get-result-tool.execute` is off the HIGH-CRAP list).
   Commit: `refactor(pi-subagents): decompose get_subagent_result into a pure report formatter`
2. **Sync architecture doc + skill** (docs).
   - Update `docs/architecture/architecture.md` (module-tree entry, Step 2 `✅` heading + `Landed:` bullet, roadmap Mermaid `S2` tick, discovery-finding-4 CRAP-list prose) and `.pi/skills/package-pi-subagents/SKILL.md` (Tools row 8 → 9 + module list, domain total 56 → 57).
   Commit: `docs(pi-subagents): record get-result-tool decomposition in architecture and skill`

Both steps are `refactor:` / `docs:` — hidden/unhidden changelog types.
As the `result-delivery` batch tail, they ship the batched release-please PR (Step 1 + Step 2) at `/ship-issue` time.

## Risks and Mitigations

- **Output drift** — a transcription slip (a separator, `Math.round`, a `??` fallback) would change the rendered report.
  Mitigation: the formatter body is a line-for-line copy of today's assembly; the new character-level `formatAgentReport` tests plus the retained `get-result-tool.test.ts` body/verbose assertions pin the exact strings.
- **Moving the terminal consume reorders a side effect** — placing the terminal consume before `buildReport` could, in principle, change behavior.
  Mitigation: `buildReport` only reads the record; consume mutates `notifications`; the two do not interact, so the reorder is provably neutral, and the consume/wait tests in `get-result-tool.test.ts` guard it.
- **New module misfiled or dead** — an unwired export fails CI.
  Mitigation: TDD Step 1 adds and wires the formatter in one commit and runs `pnpm fallow dead-code` in its verify gate.

## Open Questions

None — the decomposition is roadmap-specified (a pure report formatter alongside `result-renderer.ts`, consuming the Step 1 delivery interface), and the value-object shape follows the established `result-renderer.ts` / `AgentDetails` pure-formatter pattern.

[#535]: https://github.com/gotgenes/pi-packages/issues/535
[#538]: https://github.com/gotgenes/pi-packages/issues/538
[#541]: https://github.com/gotgenes/pi-packages/issues/541
