/**
 * Narrow exec interface matching `pi.exec()` — injected into library modules
 * so they stay free of Pi SDK imports and remain directly testable.
 */
export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;
