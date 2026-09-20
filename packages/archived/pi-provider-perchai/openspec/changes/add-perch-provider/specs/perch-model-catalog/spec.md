# perch-model-catalog

## ADDED Requirements

### Requirement: The catalog registers Roost tiers plus pinned Starter models

The provider SHALL register under provider id `perch`, with `api: "perch"`
and `baseUrl: "https://app.perchai.app"`, at minimum:

- `standard` — `roostModelChoice: "standard"`, no pin (server picks
  from the Starter pool); listed first (pi's global default model is user
  state, not provider state).
- `standard-max` — `roostModelChoice: "standard_max"`, no pin.

and additionally one entry per pinned Starter-pool model from
`models.generated.ts` (currently: Qwen 3.6, Kimi K2.5, GLM 5, Qwen3 Coder,
Nemotron Super, Gemma 4 E2B, Gemma 4 31B). All entries SHALL register
**bare** `Model.id`s (`standard`, `kimi-k2.5`, … — pi renders them
`perch/<id>`; a `perch/` prefix in the id itself would render twice and
break side-table lookups), use an all-zero `ModelCost` rates object,
`input: ["text"]`, `reasoning` per model capability, and
`contextWindow`/`maxTokens` from the generator, falling back to
131072/8192 when the bundle reports neither.

#### Scenario: Starter-only model list is usable without pins

- **WHEN** `models.generated.ts` is empty (no pins discovered)
- **THEN** the two Roost entries still register and serve turns

#### Scenario: pi model ids are namespaced

- **WHEN** pi lists models after registration
- **THEN** ids appear as `perch/<name>` (from the bare registered id) with
  the display name shown in pi's model picker

### Requirement: Thinking levels map onto Perch effort levels

The provider SHALL map pi's `reasoning` option to the request as:

| pi | Perch |
| --- | --- |
| absent | `roostReasoning:false`, `effort.level:"off"` |
| `minimal` | `effort.level:"low"` |
| `low`/`medium`/`high`/`xhigh`/`max` | same level |

#### Scenario: default turn omits reasoning

- **WHEN** the caller passes no reasoning level
- **THEN** the request carries `roostReasoning:false` and `effort.level:"off"`

#### Scenario: thinking requested

- **WHEN** the caller passes `reasoning:"high"`
- **THEN** the request carries `roostReasoning:true` and
  `effort:{level:"high", orchestration:false}`

#### Scenario: max rejected upstream

- **WHEN** the server rejects `effort.level:"max"` for the chosen model
- **THEN** the provider surfaces the server's error as-is (no auto-clamp;
  whether the Starter lane accepts `max` is an open design question — if a
  live probe later proves it accepted, remove this scenario)

### Requirement: Pins and context windows are generated, not hand-written

`scripts/discover-models.ts` SHALL derive pin ids, context windows, max
output tokens, and reasoning flags from the locally installed
`perchai-cli` bundle's model registry (or a pinned `npm pack` copy),
cross-reference membership against the Starter pool section of
`https://www.perchai.app/docs/concepts/models`, and write
`src/models.generated.ts` plus `src/cli-version.ts` (the
`perchai-cli/<version>` user agent). Generated files SHALL carry a header
naming the bundle version they were derived from.

#### Scenario: pool rotation is picked up

- **WHEN** the docs Starter pool adds a model and the installed bundle has
  a registry entry for it
- **THEN** the next `discover-models.ts` run adds it to the catalog

#### Scenario: docs pin gap fails loudly

- **WHEN** a docs-listed Starter model has no registry entry in the bundle
- **THEN** the script exits non-zero and lists the missing model instead
  of silently registering a dead pin

### Requirement: Pro-tier requests are out of scope for registration

The provider SHALL NOT register `pro` or `pro_max` models. If a user pins
one via manual configuration (not provided in v1), the server's
`starter_model_blocked` error maps to the actionable message defined in
`perch-model-call`.

#### Scenario: no accidental Pro registration

- **WHEN** discovery encounters a model whose `costTier` is not the free
  pool
- **THEN** it is excluded from the generated catalog
