import { isAbsolute, relative } from "node:path";

export interface ColGrepJsonHit {
  unit: {
    file: string;
    line: number;
    end_line: number;
  };
  score: number;
}

/**
 * Format a single colgrep JSON hit into the concise text representation:
 * `relative/path.ts:startLine-endLine [score=0.xxx]`
 *
 * Paths are made relative to `searchDir`. If the file is outside
 * `searchDir`, the absolute path is used unchanged.
 */
export function formatHit(hit: ColGrepJsonHit, searchDir: string): string {
  const rel = relative(searchDir, hit.unit.file);
  // relative() produces a path starting with ".." when outside searchDir.
  // In that case keep the absolute path for clarity.
  const displayPath =
    isAbsolute(rel) || rel.startsWith("..") ? hit.unit.file : rel;
  const score = hit.score.toFixed(3);
  return `${displayPath}:${hit.unit.line}-${hit.unit.end_line} [score=${score}]`;
}

/**
 * Parse the colgrep `--json` stdout into agent-friendly text.
 *
 * Returns `"No matches found"` for an empty result set.
 * Falls back to returning `rawOutput` unchanged when the output is not a
 * valid JSON array — defensive against unexpected colgrep output.
 * Skips individual hits that are missing required fields rather than
 * throwing, so a single malformed entry doesn't suppress all results.
 */
export function formatResults(rawOutput: string, searchDir: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return rawOutput;
  }

  if (!Array.isArray(parsed)) {
    return rawOutput;
  }

  const lines: string[] = [];
  for (const item of parsed) {
    if (!isValidHit(item)) continue;
    lines.push(formatHit(item, searchDir));
  }

  return lines.length === 0 ? "No matches found" : lines.join("\n");
}

function isValidHit(item: unknown): item is ColGrepJsonHit {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  if (typeof obj.score !== "number") return false;
  const unit = obj.unit;
  if (typeof unit !== "object" || unit === null) return false;
  const u = unit as Record<string, unknown>;
  return (
    typeof u.file === "string" &&
    typeof u.line === "number" &&
    typeof u.end_line === "number"
  );
}
