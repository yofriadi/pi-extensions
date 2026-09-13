import { type AdHocDescriptor, getAdHocDescriptor } from "./availability";
import type { Exec } from "./exec";

/**
 * Build the argv for one `mcporter call` invocation.
 *
 * Pinned argv per resolved mode (mcporter-transport spec contract):
 *  - Config mode: ["call", "<server>.<tool>", "--output", "json", "--args", json]
 *  - Ad-hoc mode: ["call", "--stdio", cmd, ...stdioArgs, "--name", serverName,
 *    "--tool", toolName, "--output", "json", "--args", json, "--yes"]
 *
 * The ad-hoc descriptor is repeated on every call (mcporter does not persist
 * ad-hoc definitions); `--yes` skips any first-run trust confirmation so a
 * headless call can never stall.
 */
export function buildCallArgs(options: {
	mode: "config" | "binary" | "npx";
	serverName: string;
	toolName: string;
	paramsJson: string;
	adHoc?: AdHocDescriptor;
}): string[] {
	if (options.mode === "config") {
		return ["call", `${options.serverName}.${options.toolName}`, "--output", "json", "--args", options.paramsJson];
	}
	const adHoc = options.adHoc ?? getAdHocDescriptor(options.mode);
	return [
		"call",
		"--stdio",
		adHoc.cmd,
		...adHoc.stdioArgs.flatMap((arg) => ["--stdio-arg", arg]),
		"--name",
		options.serverName,
		"--tool",
		options.toolName,
		"--output",
		"json",
		"--args",
		options.paramsJson,
		"--yes",
	];
}

export interface McporterCallResult {
	/** Raw stdout of the mcporter process. */
	stdout: string;
	/** Raw stderr of the mcporter process. */
	stderr: string;
	/** Exit code. */
	code: number;
	/** True when the exec seam terminated the process (timeout/abort). */
	killed: boolean;
}

/**
 * Issue exactly one mcporter call. The timeout is enforced at the Exec seam
 * (pi.exec's `timeout` option) — mcporter's own `--timeout` is not used.
 */
export async function callMcporter(
	exec: Exec,
	args: string[],
	options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<McporterCallResult> {
	const result = await exec("mcporter", args, {
		cwd: options.cwd,
		timeout: options.timeoutMs,
		signal: options.signal,
	});
	return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed };
}
