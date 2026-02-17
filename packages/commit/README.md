# pi-commit
## Install from git URL

```bash
pi install git:github.com/yofriadi/pi-extensions@commit-v<version>
```

To load only this extension from the monorepo package source, use package filtering in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@commit-v<version>",
      "extensions": ["packages/commit/src/index.ts"]
    }
  ]
}
```

AI-powered conventional commit generation for `pi` via `/commit`.

## Command

```text
/commit [--dry-run] [--push] [--split] [--no-split] [--allow-mixed-index] [--context "..."] [--model provider/model]
```

### Supported flags

- `--push`: push after commit
- `--dry-run`: preview commit message(s) only
- `--split`: force split-commit planning
- `--no-split`: disable automatic split-commit planning
- `--max-split-commits <2-12>`: cap split plan size
- `--allow-mixed-index`: bypass split safety guard for staged+unstaged same-file edits
- `--context`, `-c`: extra context for generation
- `--model`, `-m`: override model (`id` or `provider/id`)
- `--no-changelog`: skip changelog updates
- `--legacy`: accepted for compatibility (same pipeline)

## Features

- Conventional commit generation with validation + fallback
- Automatic split-commit planning with dependency ordering
- Hunk-level staging for split commits (`all` / hunk indices / line ranges), including new/untracked files when selected as `all`
- Split safety guard for mixed index/worktree files (override with `--allow-mixed-index`)
- Split execution failure handling with index reset + best-effort staged-state restore before first split commit
- Changelog orchestration for `CHANGELOG.md` unreleased sections (with cached target discovery)
- Sensitive analysis controls: sensitive paths excluded from model diff input and common secret-like values redacted
- Runtime-compatible with both Node.js and Bun (no Bun-only APIs)
