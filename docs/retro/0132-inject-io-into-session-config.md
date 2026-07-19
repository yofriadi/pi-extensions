---
issue: 132
issue_title: "Inject IO collaborators into `assembleSessionConfig`"
---

# Retro: #132 — Inject IO collaborators into `assembleSessionConfig`

## Final Retrospective (2026-05-22T12:25:00Z)

### Session summary

Defined an `AssemblerIO` interface bundling four IO/prompt collaborators, injected it into `assembleSessionConfig`, and updated `agent-runner.ts` to pass real implementations.
Eliminated all 4 `vi.mock()` calls in `session-config.test.ts`, flattened the `vi.hoisted()` block into plain `vi.fn()` declarations, and shifted assertions from mock-call verification to output-property checks.
Released as `pi-subagents-v6.10.0`.

### Observations

#### What went well

- Perl two-pass replacement (multi-line then single-line) handled 40+ `assembleSessionConfig` call-site updates in one command with zero manual errors.
- Flattening `vi.hoisted()` into regular `vi.fn()` declarations in step 3 was a clean simplification — hoisting was only needed when the mocks were referenced inside `vi.mock()` factories.
- Real `getMemoryToolNames` / `getReadOnlyMemoryToolNames` worked as drop-in replacements with no test rework needed — the pure functions' behavior matched what the mocks were configured to return for all existing test scenarios.

#### What caused friction (agent side)

- `missing-context` — `mockBuildAgentPrompt` was declared as `vi.fn(() => "assembled system prompt")` which inferred `Mock<() => string>`.
  When step 4 used `mockImplementationOnce` with a parameterized function, TypeScript rejected it.
  The testing skill already documents `Mock<specific-signature>` for this exact case.
  Impact: one type-check failure, fixed by adding `Mock<AssemblerIO["buildAgentPrompt"]>` annotation; added friction but no rework.

#### What caused friction (user side)

- Nothing notable — standard prompt-template workflow with no corrections needed.
