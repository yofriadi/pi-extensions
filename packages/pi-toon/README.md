# pi-toon

A source-only [Pi Coding Agent](https://github.com/earendil-works/pi) extension for handling information-dense JSON with `jaq`/`jq` and [TOON](https://github.com/toon-format/spec).

It adds context-aware guidance only: it does **not** transform or encode tool results automatically.

## Requirements

Install TOON and a jq-compatible query tool on `PATH`. `jaq` is preferred when
available, with `jq` as the fallback:

```bash
brew install jaq
# or: cargo install --locked jaq
# fallback: brew install jq
npm i -g @toon-format/cli
```

The extension probes them only when a JSON-related prompt is submitted.

## Install

```bash
pi install npm:@yofriadi/pi-toon
```

## Commands

```text
/toon             Toggle guidance
/toon on          Enable guidance
/toon enable      Enable guidance
/toon off         Disable guidance
/toon disable     Disable guidance
/toon status      Show current state
```

The enabled setting is stored in Pi's public agent directory as `toon.json`. The status bar shows `TOON: on`, `TOON: off`, or `TOON: unavailable`.

## Behavior

When enabled, prompts mentioning JSON, JSONL, jaq, jq, TOON, OpenAPI, or Swagger receive a system-prompt reminder to:

1. narrow data with `jaq` (preferred) or `jq`,
2. use TOON for uniform/tabular or shallow JSON read into context, and
3. keep strict JSON for API contracts, deeply nested/irregular data, and arrays of arrays.

The bundled `toon` skill contains the full workflow and examples. When both
query tools are installed, the extension tells the agent to use `jaq` first.

## Attribution

This package is a modified, TOON-only extraction from [`xynogen/pix-mono`](https://github.com/xynogen/pix-mono), specifically `packages/pix-optimizer` and `packages/pix-skills/skills/toon.md` at upstream commit [`91ae052fef28408764726c619567fd3f608549d5`](https://github.com/xynogen/pix-mono/tree/91ae052fef28408764726c619567fd3f608549d5). It removes the combined optimizer UI, pix dependencies, and all non-TOON functionality while retaining the jaq/jq/TOON guidance and heuristics.

## License

MIT. See [LICENSE](./LICENSE).
