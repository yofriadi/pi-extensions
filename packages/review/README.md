# Review Extension
## Install from git URL

```bash
pi install git:github.com/yofriadi/pi-extensions@review-v<version>
```

To load only this extension from the monorepo package source, use package filtering in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@review-v<version>",
      "extensions": ["packages/review/src/index.ts"]
    }
  ]
}
```

Self-contained interactive code review extension for pi.

This package extracts the core `/review` workflow from oh-my-pi and adapts it to work in both Node.js-based pi and Bun-based forks.

## Features

- `/review` command with interactive mode selection:
  - branch comparison (PR style)
  - uncommitted changes (staged + unstaged)
  - specific commit
  - custom instructions
- Diff parsing and noisy-file filtering (locks, generated assets, binaries, etc.)
- Memory-aware diff metadata (stores compact per-file previews, not full duplicated hunks)
- Task-aware prompt generation:
  - if `task` tool exists, prompt suggests parallel reviewer orchestration
  - otherwise uses direct in-session review flow
- Structured review tools:
  - `report_finding` (deduplicates repeated findings, normalizes title/path/range)
  - `submit_review` (stores verdict and compares against finding-based suggested verdict)
- Security hardening:
  - finding paths are sanitized to workspace-relative paths only
  - commit/branch refs are validated with `git rev-parse --verify ...^{commit}` before use
- Session state eviction (TTL + bounded max entries)
- Session-local status commands:
  - `/review-status`
  - `/review-reset`

## Commands

- `/review`
- `/review uncommitted`
- `/review branch main`
- `/review commit <hash>`
- `/review custom <instructions>`
- `/review-status`
- `/review-reset`

## Tools

### report_finding

Parameters:

```json
{
  "title": "[P1] Handle null API response",
  "body": "If the backend returns null, this path throws before fallback logic runs.",
  "priority": "P1",
  "confidence": 0.87,
  "file_path": "src/api/client.ts",
  "line_start": 41,
  "line_end": 45
}
```

### submit_review

Parameters:

```json
{
  "verdict": "request_changes",
  "summary": "The patch introduces one high-impact null handling regression.",
  "confidence": 0.84
}
```

## Runtime compatibility

- Uses only extension APIs (`pi.exec`, `pi.registerCommand`, `pi.registerTool`)
- No Bun-specific APIs
- No Node-only process-spawn code

## Install

```bash
pi install ./packages/review
```

Or load directly:

```bash
pi -e ./packages/review/src/index.ts
```
