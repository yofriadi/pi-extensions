---
issue: 192
issue_title: "Define SessionContext narrow interface"
---

# Define `SessionContext` narrow interface

## Problem Statement

`SubagentRuntime.currentCtx` is typed `{ pi: unknown; ctx: unknown }`.
Every consumer must cast through `as any` to read fields from the SDK context.
This forces context queries (`buildSnapshot`, `getModelInfo`, `getSessionInfo`) to live as closures in `index.ts` with repeated `as any` casts, rather than as typed methods on the state holder.

The SDK exports `ExtensionContext` — the `unknown` typing is a historical choice, not a constraint.

## Goals

- Define a narrow `SessionContext` interface in `src/types.ts` capturing the 5 fields `SubagentRuntime` actually reads.
- Pure additive — no consumers change in this step.
- Provide the typed foundation for Layer 1 (#193) and subsequent closure-to-class conversion issues.

## Non-Goals

- Changing `SubagentRuntime.currentCtx` type (that's #193).
- Converting closure factories to classes (#195, #196).
- Removing any `as any` casts from `index.ts` (that's #193).

## Background

Phase 11, Layer 0 in `docs/architecture/architecture.md`.
This is the first step in a 5-issue sequence (issues #192–#196) that converts closure factories to classes, eliminating 44 adapter closures in `index.ts`.

The SDK's `ExtensionContext` interface (in `@earendil-works/pi-coding-agent`) is broad — it exposes `ui`, `abort()`, `shutdown()`, `compact()`, etc.
ISP (Interface Segregation Principle) from `code-design` mandates a narrow interface capturing only what `SubagentRuntime` needs.

The 5 fields consumed by runtime (traced from `index.ts` lines 214–223 and `lifecycle/parent-snapshot.ts`):

1. `cwd` — working directory for agent sessions.
2. `model` — parent model instance for fallback resolution.
3. `modelRegistry` — resolving config model strings.
4. `getSystemPrompt()` — system prompt for append-mode agents.
5. `sessionManager.getSessionFile()` / `.getSessionId()` / `.getBranch()` — session identification and context inheritance.

The local `ModelRegistry` interface (in `src/session/model-resolver.ts`) already exists as a narrow ISP interface.
`SessionContext` will reference it rather than redeclaring model-registry methods inline.

## Design Overview

```typescript
import type { ModelRegistry } from "#src/session/model-resolver";

/**
 * Narrow interface capturing the 5 ExtensionContext fields SubagentRuntime needs.
 * Avoids coupling runtime to the full SDK ExtensionContext surface.
 */
export interface SessionContext {
  readonly cwd: string;
  readonly model: unknown;
  readonly modelRegistry: ModelRegistry | undefined;
  getSystemPrompt(): string;
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
    getBranch(): unknown[];
  };
}
```

Design decisions:

1. `model` stays `unknown` — the runtime only passes it through to `resolveModel`; narrowing it gains nothing and would couple to `@earendil-works/pi-ai`'s `Model<Api>` generic.
2. `modelRegistry` is `ModelRegistry | undefined` — the SDK type says `ModelRegistry` (non-optional), but `SubagentRuntime.currentCtx` can be undefined, and the architecture doc specifies this signature.
   The `| undefined` reflects reality at the cast boundary (pre-bind, the registry may not exist).
3. `sessionManager` uses an inline structural type rather than importing `ReadonlySessionManager` — we only need 3 of its 13 methods; a separate named type would be over-engineering for a nested structural slice.
4. `getBranch()` returns `unknown[]` — the runtime passes entries through to `buildParentContext()` which already type-narrows internally.

## Module-Level Changes

| File           | Change                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/types.ts` | Add `SessionContext` interface export. Add `import type { ModelRegistry }` from `#src/session/model-resolver`. |

No other files change — this is pure additive.

## Test Impact Analysis

1. No new unit tests are needed — `SessionContext` is a pure type definition with no runtime behavior.
2. No existing tests become redundant.
3. A compile-time check (`pnpm run check`) verifies the interface is well-formed and the import resolves.

## TDD Order

1. **Add `SessionContext` interface to `src/types.ts`** — add the interface with its import.
   Verify with `pnpm run check` (type-check passes).
   Commit: `feat(pi-subagents): define SessionContext narrow interface (#192)`

## Risks and Mitigations

| Risk                                                             | Mitigation                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Interface shape doesn't match real `ExtensionContext` at runtime | Traced all 5 fields against SDK `.d.ts` declarations; shapes align exactly.                                                |
| Circular import from `types.ts` → `session/model-resolver.ts`    | `model-resolver.ts` does not import from `types.ts`; no cycle.                                                             |
| Future SDK changes break the narrow interface                    | The cast boundary (Layer 1, #193) will be the single enforcement point — structural typing ensures compile-time detection. |

## Open Questions

None — the issue's "Proposed change" section fully specifies the interface shape.
