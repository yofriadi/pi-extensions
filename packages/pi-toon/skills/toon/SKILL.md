---
name: toon
description: Manipulate information-dense JSON efficiently with jaq (preferred) or jq plus TOON. Use when fetching/reading large or repetitive JSON (LLM schemas, OpenAPI specs, API responses, datasets, config dumps) into context. Query/reshape with jaq or jq, compress to TOON to cut tokens, decode back to JSON only when a strict contract needs it.
disable-model-invocation: true
---

# TOON + jaq/jq: Dense JSON Workflow

## Goal
Carry only the JSON slice you need, in the cheapest encoding. Query with `jaq`
(preferred) or its `jq` fallback, compress with `toon`, and round-trip back to
JSON **only** when a contract requires strict JSON.

TOON (Token-Oriented Object Notation, https://github.com/toon-format/spec) is a
line-oriented encoding of the JSON data model. Uniform arrays of objects declare
their keys once and stream bare rows, so token cost drops sharply on tabular and
dense data.

## The pipeline

```bash
# Fetch → reshape → compress (most common)
curl -s https://api.example.com/models | jaq '.data' | toon
# If jaq is unavailable, use jq instead.

# Local file, show token savings
cat openapi.json | jaq '.paths' | toon --stats
# If jaq is unavailable, use jq instead.

# Just compress, no query
cat data.json | toon

# Convert TOON back to JSON (strict contract / downstream parser)
echo "$TOON_BLOB" | toon -d
cat data.toon | toon --decode
```

`jaq` is a jq-compatible command-line replacement focused on correctness, speed,
and simplicity. Prefer it when installed; use `jq` when it is not. `toon`
auto-detects direction from input. Force it with `-e` (encode JSON→TOON) or `-d`
(decode TOON→JSON).

### Useful flags
- `--stats` — print token/byte statistics for the conversion
- `--delimiter=,|\t|"|"` — array delimiter (comma default; tab/pipe can tokenize better)
- `--keyFolding=safe` — collapse single-key nesting chains
- `--no-strict` — lenient decode

## Decide before you compress

TOON is not always smaller. Pick based on shape:

| Shape | Action | Why |
|---|---|---|
| Uniform array of objects (same keys, primitive values) | **TOON** | Sweet spot — keys declared once, rows streamed; savings scale with rows × fields |
| Flat object / primitive array | **TOON** | Drops quotes and braces |
| Shallow nesting | **TOON** | Indentation cheaper than braces at low depth |
| Deeply nested / non-uniform | **JSON** | Indentation cost grows; compact JSON can win |
| Array of arrays | **JSON** | TOON's one structurally-worse case (explicit list markers + inner headers) |
| API contract / payload to send or store | **JSON** | Must stay valid JSON for the consumer |

Rule of thumb: **TOON for reading dense data into context. JSON for contracts.**

## When NOT to use TOON
- Anything sent to or stored by an API that expects JSON.
- Data a downstream tool/parser must consume as strict JSON.
- Deeply nested config trees or highly irregular structures.
- Tiny payloads where the conversion overhead isn't worth it.

In those cases, still use `jaq` (or `jq` if jaq is unavailable) to slice down to
what you need — just skip the `| toon` step.

## Worked examples

LLM model list (uniform array → great TOON candidate):

```bash
curl -s https://api.example.com/v1/models | jaq '.data | map({id, owned_by, context})' | toon
# If jaq is unavailable, replace jaq with jq.
```
```
[3]{id,owned_by,context}:
  gpt-x,acme,128000
  gpt-y,acme,200000
  gpt-z,acme,1000000
```

OpenAPI paths summary (reshape first, then compress):

```bash
cat openapi.json \
  | jaq '[.paths | to_entries[] | {path: .key, methods: (.value | keys)}]' \
  | toon --stats
# If jaq is unavailable, replace jaq with jq.
```

Round-trip back to JSON for an API call:

```bash
RESHAPED=$(cat payload.toon | toon -d)
curl -s -X POST https://api.example.com/ingest -d "$RESHAPED"
```

## Installation

Install `jaq` from its releases, Homebrew, or Cargo. It is preferred because it
is a fast, correctness-focused jq-compatible replacement:

```bash
brew install jaq
# or: cargo install --locked jaq
```

If jaq is unavailable, install the fallback:

```bash
brew install jq
```

Install TOON separately:

```bash
npm i -g @toon-format/cli
```

## Checklist
1. **Query** — narrow with `jaq` (preferred) or `jq` to the exact slice needed.
2. **Decide** — uniform/tabular/shallow → TOON; nested/array-of-arrays/contract → JSON.
3. **Compress** — `| toon` (add `--stats` to confirm savings).
4. **Round-trip** — `toon -d` only when strict JSON is required downstream.
