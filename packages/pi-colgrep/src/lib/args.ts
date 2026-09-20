export interface SearchParams {
  query?: string;
  regex?: string;
  path?: string;
  glob?: string;
  limit?: number;
  context?: number;
}

/**
 * Build the CLI argument list for a colgrep search invocation.
 *
 * Always includes `--json`. Positional arguments (query, path) come last
 * so flags are unambiguously parsed by the CLI.
 */
export function buildSearchArgs(params: SearchParams): string[] {
  const args: string[] = ["--json"];

  if (params.regex !== undefined) {
    args.push("-e", params.regex);
  }
  if (params.glob !== undefined) {
    args.push("--include", params.glob);
  }
  if (params.limit !== undefined) {
    args.push("-k", String(params.limit));
  }
  if (params.context !== undefined) {
    args.push("-n", String(params.context));
  }

  // Positional: query comes before path
  if (params.query !== undefined) {
    args.push(params.query);
  }
  if (params.path !== undefined) {
    args.push(params.path);
  }

  return args;
}
