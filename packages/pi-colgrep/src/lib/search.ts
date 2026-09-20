import { buildSearchArgs, type SearchParams } from "./args";
import type { Exec } from "./exec";
import { formatResults } from "./format";

export interface SearchResult {
  /** Formatted hit lines, present on success. */
  output?: string;
  /** Error message, present on failure. */
  error?: string;
}

/**
 * Run a colgrep search and return formatted results.
 *
 * Paths in the output are relativized against `params.path` when provided,
 * otherwise against `cwd`.
 */
export async function runSearch(
  exec: Exec,
  params: SearchParams,
  cwd: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const args = buildSearchArgs(params);
  const result = await exec("colgrep", args, { cwd, signal });

  if (result.code !== 0) {
    const detail = result.stderr.trim();
    const message = detail
      ? detail
      : `colgrep exited with exit code ${result.code}`;
    return { error: message };
  }

  const searchDir = params.path ?? cwd;
  return { output: formatResults(result.stdout, searchDir) };
}
