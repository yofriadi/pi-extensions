# @yofriadi/pi-fuzzy-match
## Install from git URL

```bash
pi install git:github.com/yofriadi/pi-extensions@fuzzy-match-v<version>
```

To load only this extension from the monorepo package source, use package filtering in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@fuzzy-match-v<version>",
      "extensions": ["packages/fuzzy-match/src/index.ts"]
    }
  ]
}
```

Fuzzy matching utilities for pi — progressive matching strategies for finding text in files.

## Overview

Provides both character-level and line-level fuzzy matching with progressive fallback strategies for edit tool operations.

## Usage

```ts
import {
  findMatch,
  seekSequence,
  findContextLine,
  similarity,
  DEFAULT_FUZZY_THRESHOLD,
} from "@yofriadi/pi-fuzzy-match";

// Find text with fuzzy matching
const result = findMatch(fileContent, searchText, {
  allowFuzzy: true,
  threshold: 0.95,
});

// Find line sequences with progressive fallback
const seqResult = seekSequence(
  lines,
  patternLines,
  0,     // start index
  false, // eof mode
  { allowFuzzy: true }
);

// Find a context line
const contextResult = findContextLine(lines, "function hello()", 0);

// Compute string similarity (0-1)
const score = similarity("hello world", "hello  world"); // ~0.95
```

## Matching Strategies

The fuzzy matching uses progressive fallback strategies:

1. **Exact match** - Identical content
2. **Trailing whitespace stripped** - Ignores trailing spaces
3. **Trimmed match** - Ignores leading/trailing whitespace
4. **Comment-prefix normalized** - Ignores comment markers
5. **Unicode normalized** - Normalizes fancy quotes/dashes to ASCII
6. **Prefix match** - Pattern is prefix of line
7. **Substring match** - Pattern is substring of line
8. **Fuzzy similarity** - Levenshtein-based similarity scoring

## API

| Function | Description |
|----------|-------------|
| `findMatch(content, target, options)` | Find text with optional fuzzy matching |
| `seekSequence(lines, pattern, start, eof, options?)` | Find line sequence with progressive strategies |
| `findContextLine(lines, context, startFrom, options?)` | Find a context line with fallbacks |
| `findClosestSequenceMatch(lines, pattern, options?)` | Find best fuzzy sequence match |
| `levenshteinDistance(a, b)` | Compute edit distance |
| `similarity(a, b)` | Compute similarity score (0-1) |
| `normalizeForFuzzy(line)` | Normalize for fuzzy comparison |
| `normalizeUnicode(s)` | Normalize Unicode to ASCII equivalents |

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_FUZZY_THRESHOLD` | `0.95` | Default similarity threshold |

## License

MIT
