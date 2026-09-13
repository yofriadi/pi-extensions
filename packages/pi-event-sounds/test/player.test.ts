/**
 * Player unit tests: backend selection, volume clamping/scaling, missing-file
 * no-op, error swallowing, TTY-gated bell. All spawning is injected through
 * the PlayerSeams — no real process is spawned (spec: sound-playback).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampVolume, detectBackend, playSound, resetBackendCache } from "../src/player";

let tempDir: string;
const spawned: { cmd: string; args: string[] }[] = [];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sounds-player-"));
	spawned.length = 0;
	resetBackendCache();
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** Exec seam that records the spawn and never errors. */
function recordingExec(error?: Error): (cmd: string, args: string[], cb: (err: Error | null) => void) => void {
	return (cmd, args, cb) => {
		spawned.push({ cmd, args });
		cb(error ?? null);
	};
}

describe("backend detection", () => {
	it("selects darwin when afplay is on PATH", () => {
		expect(detectBackend({ platform: "darwin", probe: (bin) => bin === "afplay", exec: recordingExec() })).toBe(
			"darwin",
		);
	});

	it("prefers paplay over aplay on linux", () => {
		expect(
			detectBackend({
				platform: "linux",
				probe: (bin) => bin === "paplay" || bin === "aplay",
				exec: recordingExec(),
			}),
		).toBe("linux-paplay");
	});

	it("falls back to aplay when paplay is missing", () => {
		expect(detectBackend({ platform: "linux", probe: (bin) => bin === "aplay", exec: recordingExec() })).toBe(
			"linux-aplay",
		);
	});

	it("falls back to the terminal bell when no binary exists", () => {
		expect(detectBackend({ platform: "darwin", probe: () => false, exec: recordingExec() })).toBe("terminal");
	});

	it("selects powershell on windows", () => {
		expect(
			detectBackend({ platform: "win32", probe: (bin) => bin === "powershell.exe", exec: recordingExec() }),
		).toBe("windows");
	});

	it("memoizes the decision for the process lifetime", () => {
		let calls = 0;
		const probe = () => {
			calls += 1;
			return true;
		};
		detectBackend({ platform: "darwin", probe, exec: recordingExec() });
		detectBackend({ platform: "darwin", probe, exec: recordingExec() });
		detectBackend({ platform: "darwin", probe, exec: recordingExec() });
		expect(calls).toBe(1);
	});
});

describe("playSound", () => {
	it("invokes afplay with a 0..1 volume on darwin", () => {
		const file = writeFile("a.wav");
		playSound(file, 0.4, "darwin", { exec: recordingExec() });
		expect(spawned).toEqual([{ cmd: "afplay", args: ["-v", "0.4", file] }]);
	});

	it("scales volume to 0..65536 for paplay", () => {
		const file = writeFile("a.wav");
		playSound(file, 1, "linux-paplay", { exec: recordingExec() });
		expect(spawned).toEqual([{ cmd: "paplay", args: ["--volume=65536", file] }]);
	});

	it("passes no volume flag to aplay", () => {
		const file = writeFile("a.wav");
		playSound(file, 0.4, "linux-aplay", { exec: recordingExec() });
		expect(spawned).toEqual([{ cmd: "aplay", args: [file] }]);
	});

	it("invokes PowerShell SoundPlayer on windows", () => {
		const file = writeFile("a.wav");
		playSound(file, 0.4, "windows", { exec: recordingExec() });
		expect(spawned.length).toBe(1);
		expect(spawned[0]?.cmd).toBe("powershell.exe");
		expect(spawned[0]?.args[0]).toBe("-NoProfile");
		expect(spawned[0]?.args[3]).toContain("SoundPlayer");
	});

	it("is a silent no-op when the file is missing", () => {
		playSound(join(tempDir, "missing.wav"), 0.4, "darwin", { exec: recordingExec() });
		expect(spawned).toEqual([]);
	});

	it("swallows exec errors without throwing", () => {
		const file = writeFile("a.wav");
		expect(() => playSound(file, 0.4, "darwin", { exec: recordingExec(new Error("boom")) })).not.toThrow();
	});

	it("swallows a callback error (player crashed)", () => {
		const file = writeFile("a.wav");
		const throwingExec = (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
			cb(new Error("exit 1"));
		};
		expect(() => playSound(file, 0.4, "darwin", { exec: throwingExec })).not.toThrow();
	});

	it("returns immediately without awaiting the player (fire-and-forget)", () => {
		const file = writeFile("long.wav");
		const neverCalls: (cmd: string, args: string[], cb: (err: Error | null) => void) => void = (
			_cmd,
			_args,
			cb,
		) => {
			// Never invoke the callback — the handler must still have returned.
			void cb;
		};
		playSound(file, 0.4, "darwin", { exec: neverCalls });
		expect(spawned).toEqual([]);
	});

	it("writes the bell to stderr on terminal backend when stderr is a TTY", () => {
		const file = writeFile("a.wav");
		const writes: string[] = [];
		const stderr = {
			isTTY: true,
			write: (text: string) => {
				writes.push(text);
				return true;
			},
		};
		playSound(file, 0.4, "terminal", { exec: recordingExec(), stderr });
		expect(writes).toEqual(["\x07"]);
	});

	it("suppresses the bell entirely when stderr is not a TTY", () => {
		const file = writeFile("a.wav");
		const writes: string[] = [];
		const stderr = {
			isTTY: false,
			write: (text: string) => {
				writes.push(text);
				return true;
			},
		};
		playSound(file, 0.4, "terminal", { exec: recordingExec(), stderr });
		expect(writes).toEqual([]);
		expect(spawned).toEqual([]);
	});
});

describe("clampVolume", () => {
	it("clamps 2.5 to 1", () => {
		expect(clampVolume(2.5)).toBe(1);
	});

	it("clamps -3 to 0", () => {
		expect(clampVolume(-3)).toBe(0);
	});

	it("passes through values inside 0..1", () => {
		expect(clampVolume(0.4)).toBe(0.4);
		expect(clampVolume(0)).toBe(0);
		expect(clampVolume(1)).toBe(1);
	});

	it("maps non-finite values to 0", () => {
		expect(clampVolume(Number.NaN)).toBe(0);
		expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(0);
	});
});

/** Create a sound file in the temp dir and return its absolute path. */
function writeFile(name: string): string {
	const file = join(tempDir, name);
	writeFileSync(file, "RIFF");
	return file;
}
