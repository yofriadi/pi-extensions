# Web-Access Extension

Standalone package extension for web fetching and search.

This extension registers:
- `fetch_content` tool
- `web_search` tool
- `/web-status` command
- `/web-access-status` command (alias)

## Install and Load

### One-off load

```bash
pi -e ./packages/coding-agent/examples/extensions/web-access
```

### Install as package source

```bash
pi install ./packages/coding-agent/examples/extensions/web-access
```

After loading, run:

```bash
/web-status
```

## Key Configuration

Environment variables (highest priority):

- `EXA_API_KEY` (or `PI_EXA_API_KEY`)
- `PERPLEXITY_API_KEY` (or `PI_PERPLEXITY_API_KEY`)

Optional JSON config files (later entries override earlier ones):

1. `~/.pi/web-access.json`
2. `~/.pi/agent/web-access.json`
3. `<project>/.pi/web-access.json`
4. Explicit path passed to `/web-access-status <path>`

Example config:

```json
{
  "exaApiKey": "your-exa-key",
  "perplexityApiKey": "your-perplexity-key"
}
```

Nested provider form is also accepted:

```json
{
  "exa": { "apiKey": "your-exa-key" },
  "perplexity": { "apiKey": "your-perplexity-key" }
}
```

## Tool Usage

### fetch_content

Fetches web content using a scraper registry with Jina Reader as first fallback.

Example parameters:

```json
{
  "url": "https://bun.sh/docs",
  "timeoutMs": 20000,
  "maxChars": 20000,
  "prefer": "jina"
}
```

### web_search

Searches via Exa (resource-heavy mode) or Perplexity (answer-heavy mode).

Example parameters:

```json
{
  "query": "Bun spawn docs",
  "mode": "resources",
  "provider": "auto",
  "limit": 5
}
```

Provider routing behavior:

- `mode=resources`: prefers Exa, falls back to Perplexity
- `mode=answer`: prefers Perplexity, falls back to Exa
- `provider=exa|perplexity`: force a provider
