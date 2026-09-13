/**
 * Cross-platform best-effort sound playback.
 *
 * Backend selection probes PATH once per process (memoized). Playback is
 * fire-and-forget `execFile` — never awaited, never blocking, every error
 * swallowed: a missing file is a silent no-op, a crashing player is ignored.
 * The terminal-bell fallback writes BEL to stderr only when stderr is a TTY
 * (pi's stdout is a structured channel in print/rpc modes).
 */

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";

/** Detected playback strategy. */
export type SoundBackend = "darwin" | "linux-paplay" | "linux-aplay" | "windows" | "terminal";

/** Seams for tests: probe + exec + stderr injection. */
export interface PlayerSeams {
	/** PATH probe replacement — true when the binary is resolvable. */
	probe?: (bin: string) => boolean;
	/** execFile replacement — same call shape as node:child_process.execFile. */
	exec?: (cmd: string, args: string[], callback: (err: Error | null) => void) => void;
	/** Terminal-bell target. Defaults to process.stderr. */
	stderr?: { isTTY?: boolean; write(text: string): boolean };
	/** Platform override for tests. Defaults to the real platform. */
	platform?: NodeJS.Platform;
}

/** Memoized backend decision for this process. */
let cachedBackend: SoundBackend | undefined;

/**
 * Check whether a binary resolves on PATH as an executable file. Scans PATH
 * directories directly rather than spawning a shell helper: `command -v` is
 * a shell builtin that `execFile` cannot invoke.
 */
function probeBinary(bin: string): boolean {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return false;
	const isWindows = platform() === "win32";
	const candidates = isWindows && !/\.[a-z]+$/i.test(bin) ? [`${bin}.exe`, bin] : [bin];
	for (const dir of pathEnv.split(delimiter)) {
		if (dir.length === 0) continue;
		for (const candidate of candidates) {
			try {
				if (statSync(join(dir, candidate)).isFile()) return true;
			} catch {
				// Not in this directory — keep scanning.
			}
		}
	}
	return false;
}

/**
 * Detect the playback backend for this platform by probing PATH.
 * Memoized for the process lifetime — probing on every sound is wasteful.
 * Falls back to the terminal bell when no player binary exists.
 */
export function detectBackend(seams: PlayerSeams = {}): SoundBackend {
	if (cachedBackend) return cachedBackend;
	const probe = seams.probe ?? probeBinary;
	const os = seams.platform ?? platform();
	let backend: SoundBackend = "terminal";
	if (os === "darwin") {
		if (probe("afplay")) backend = "darwin";
	} else if (os === "win32") {
		if (probe("powershell.exe") || probe("powershell")) backend = "windows";
	} else {
		if (probe("paplay")) backend = "linux-paplay";
		else if (probe("aplay")) backend = "linux-aplay";
	}
	cachedBackend = backend;
	return backend;
}

/** Test seam: reset the memoized backend decision. */
export function resetBackendCache(): void {
	cachedBackend = undefined;
}

/** Clamp a volume hint into 0..1. Non-finite values become 0. */
export function clampVolume(volume: number): number {
	if (!Number.isFinite(volume)) return 0;
	return Math.min(1, Math.max(0, volume));
}

const BELL = "\x07";

/** PowerShell SoundPlayer invocation (wav-only; volume relies on the system). */
function windowsArgs(file: string): { cmd: string; args: string[] } {
	const escaped = file.replace(/'/g, "''");
	return {
		cmd: "powershell.exe",
		args: ["-NoProfile", "-NonInteractive", "-Command", `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`],
	};
}

/** Error callback that discards everything (execFile requires an error-first callback). */
function swallow(_err: Error | null): void {}

/**
 * Play a sound file: best-effort, fire-and-forget.
 *
 * - Missing/unreadable file → silent no-op (checked before spawning).
 * - Errors from spawn or player exit are swallowed.
 * - Volume is a 0..1 hint: `afplay -v` takes it natively; `paplay --volume`
 *   is scaled to 0..65536; other backends rely on system volume.
 */
export function playSound(file: string, volume: number, backend: SoundBackend, seams: PlayerSeams = {}): void {
	try {
		accessSync(file, fsConstants.R_OK);
	} catch {
		return;
	}
	const v = clampVolume(volume);
	const exec = seams.exec ?? ((cmd, args, cb) => execFile(cmd, args, cb));

	try {
		switch (backend) {
			case "darwin":
				exec("afplay", ["-v", String(v), file], swallow);
				break;
			case "linux-paplay":
				exec("paplay", [`--volume=${Math.round(v * 65536)}`, file], swallow);
				break;
			case "linux-aplay":
				exec("aplay", [file], swallow);
				break;
			case "windows": {
				const { cmd, args } = windowsArgs(file);
				exec(cmd, args, swallow);
				break;
			}
			case "terminal": {
				// Bell only on an interactive stderr — never pollute piped
				// output or the JSON-RPC stream.
				const stderr = seams.stderr ?? process.stderr;
				if (stderr.isTTY) stderr.write(BELL);
				break;
			}
		}
	} catch {
		// Playback must never break the agent loop.
	}
}
