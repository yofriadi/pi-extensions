# @yofriadi/pi-hashline-edit
## Install from git URL

```bash
pi install git:github.com/yofriadi/pi-extensions@hashline-edit-v<version>
```

To load only this extension from the monorepo package source, use package filtering in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@hashline-edit-v<version>",
      "extensions": ["packages/hashline-edit/src/index.ts"]
    }
  ]
}
```

Hashline edit mode for pi — a line-addressable edit format using content hashes.

## Overview

Each line in a file is identified by its 1-indexed line number and an 8-char base16 hash derived from the exact line content (except trailing `\r`). The combined `LINE:HASH` reference acts as both an address and a staleness check.

**Displayed format:** `LINENUM:HASH|CONTENT`  
**Reference format:** `"LINENUM:HASH"` (e.g. `"5:a3f19c2e"`)

## Usage

```ts
import {
  computeLineHash,
  formatHashLines,
  applyHashlineEdits,
  parseLineRef,
} from "@yofriadi/pi-hashline-edit";

// Format file content with hashline prefixes
const content = "function hello() {\n  return 'world';\n}";
const formatted = formatHashLines(content);
// "1:a3f19c2e|function hello() {\n2:5b0ea94c|  return 'world';\n3:0f8a2c11|}"

// Compute hash for a single line
const hash = computeLineHash(1, "function hello() {");

// Apply edits with hash verification
const result = applyHashlineEdits(content, [
  { set_line: { anchor: "2:5b0ea94c", new_text: "  return 'universe';" } },
]);
```

## Edit Operations

- **`set_line`**: Replace a single line
- **`replace_lines`**: Replace a contiguous range of lines
- **`insert_after`**: Add new content after an anchor line

> Note: `replace` payloads are intentionally not handled by `applyHashlineEdits`; they should be processed by a separate replace-mode flow.

## API

| Function | Description |
|----------|-------------|
| `computeLineHash(idx, line)` | Compute short hash for a line |
| `formatHashLines(content, startLine?)` | Format content with `LINE:HASH\|` prefixes |
| `applyHashlineEdits(content, edits)` | Apply hashline edits with validation |
| `parseLineRef(ref)` | Parse `"LINE:HASH"` string to `{line, hash}` |
| `validateLineRef(ref, fileLines)` | Validate hash matches current content |
| `streamHashLinesFromUtf8(source, options?)` | Stream hashline output from bytes |
| `streamHashLinesFromLines(lines, options?)` | Stream hashline output from lines |

## License

MIT
