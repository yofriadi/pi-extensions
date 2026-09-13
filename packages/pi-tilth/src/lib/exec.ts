/**
 * Narrow exec interface matching `pi.exec()` — injected into library modules
 * so they stay free of Pi SDK imports and remain directly testable.
 *
 * `killed` mirrors pi's ExecResult: true when the process was terminated by the
 * timeout timer or an AbortSignal (SIGTERM/SIGKILL), regardless of the exit
 * code the OS reports. Pi resolves `code ?? 0` for signal-deaths, so callers
 * must consult `killed`, never `code` alone.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type Exec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;
