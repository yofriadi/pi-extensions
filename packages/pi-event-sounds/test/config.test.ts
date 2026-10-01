/**
 * Config unit tests: lookup precedence, defaults, normalization, malformed
 * input tolerance (spec: sound-configuration).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_QUOTA_PATTERNS, defaultConfig, resolveConfig } from "../src/config";

let projectRoot: string;
let agentDir: string;
let dirs: string[] = [];

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), "sounds-project-"));
	agentDir = mkdtempSync(join(tmpdir(), "sounds-agent-"));
	dirs = [projectRoot, agentDir];
});

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function writeProjectSettings(content: string): void {
	mkdirSync(join(projectRoot, ".pi"), { recursive: true });
	writeFileSync(join(projectRoot, ".pi", "settings.json"), content);
}

function writeGlobalSettings(content: string): void {
	writeFileSync(join(agentDir, "settings.json"), content);
}

describe("lookup precedence", () => {
	it("uses defaults when no settings file defines sounds anywhere", () => {
		const config = resolveConfig(projectRoot, agentDir);
		expect(config).toEqual(defaultConfig());
	});

	it("project sounds override global sounds", () => {
		writeProjectSettings('{"sounds": {"events": {"promptSubmit": ["p.wav"]}}}');
		writeGlobalSettings('{"sounds": {"events": {"promptSubmit": ["g.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.promptSubmit).toEqual([join(projectRoot, "p.wav")]);
	});

	it("project file without a sounds key falls through to global", () => {
		writeProjectSettings('{"theme": "dark"}');
		writeGlobalSettings('{"sounds": {"events": {"agentSettled": ["g.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.agentSettled).toEqual([join(agentDir, "g.wav")]);
	});

	it("skips unreadable (malformed JSON) files without throwing", () => {
		writeProjectSettings("{ not json");
		writeGlobalSettings('{"sounds": {"volume": 0.9}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.volume).toBe(0.9);
	});
});

describe("defaults", () => {
	it("enabled, default volume, empty event lists, default quota patterns", () => {
		const config = defaultConfig();
		expect(config.enabled).toBe(true);
		expect(config.volume).toBe(0.4);
		expect(config.events.sessionStart).toEqual([]);
		expect(config.events.promptSubmit).toEqual([]);
		expect(config.events.agentStart).toEqual([]);
		expect(config.events.agentSettled).toEqual([]);
		expect(config.events.question).toEqual([]);
		expect(config.events.error).toEqual([]);
		expect(config.events.quota).toEqual([]);
		expect(config.events.agentFailed).toEqual([]);
		expect(config.events.agentAborted).toEqual([]);
		expect(config.turns).toEqual([]);
		expect(config.elapsed).toEqual([]);
		expect(config.quotaPatterns).toEqual(DEFAULT_QUOTA_PATTERNS);
	});

	it("agentFailed and agentAborted stay [] when absent from a sounds object", () => {
		writeProjectSettings('{"sounds": {"events": {"promptSubmit": ["p.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.promptSubmit).toEqual([join(projectRoot, "p.wav")]);
		expect(config.events.agentFailed).toEqual([]);
		expect(config.events.agentAborted).toEqual([]);
	});
});

describe("normalization", () => {
	it("bare string becomes a one-element array", () => {
		writeProjectSettings('{"sounds": {"events": {"promptSubmit": "~/sounds/yes.wav"}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.promptSubmit).toEqual([join(homedirSafe(), "sounds", "yes.wav")]);
	});

	it("tilde expands to the home directory", () => {
		writeProjectSettings('{"sounds": {"events": {"error": ["~/e.wav", "/abs/e2.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.error).toEqual([join(homedirSafe(), "e.wav"), "/abs/e2.wav"]);
	});

	it("relative paths resolve against the project root for project settings", () => {
		writeProjectSettings('{"sounds": {"events": {"sessionStart": ["s.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.sessionStart).toEqual([join(projectRoot, "s.wav")]);
	});

	it("relative paths resolve against agentDir for global settings", () => {
		writeGlobalSettings('{"sounds": {"events": {"sessionStart": ["sounds/song.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.sessionStart).toEqual([join(agentDir, "sounds", "song.wav")]);
	});

	it("agentFailed and agentAborted resolve configured paths against the source base dir", () => {
		writeProjectSettings('{"sounds": {"events": {"agentFailed": ["f.wav"], "agentAborted": ["a.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.agentFailed).toEqual([join(projectRoot, "f.wav")]);
		expect(config.events.agentAborted).toEqual([join(projectRoot, "a.wav")]);
	});

	it("clamps out-of-range volume into 0..1", () => {
		writeProjectSettings('{"sounds": {"volume": 2.5}}');
		expect(resolveConfig(projectRoot, agentDir).volume).toBe(1);
		writeProjectSettings('{"sounds": {"volume": -3}}');
		expect(resolveConfig(projectRoot, agentDir).volume).toBe(0);
	});

	it("accepts turns and elapsed blocks", () => {
		writeProjectSettings(
			'{"sounds": {"turns": {"every": 50, "files": ["t.wav"]}, "elapsed": {"seconds": 300, "repeat": true, "files": ["e.wav"]}}}',
		);
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.turns).toEqual([{ every: 50, files: [join(projectRoot, "t.wav")] }]);
		expect(config.elapsed).toEqual([{ seconds: 300, repeat: true, files: [join(projectRoot, "e.wav")] }]);
	});

	it("accepts value lists for turns.at and elapsed.seconds", () => {
		writeProjectSettings(
			'{"sounds": {"turns": {"at": [100, 25, 50, 25], "files": ["t.wav"]}, "elapsed": {"seconds": [1000, 300], "repeat": false, "files": ["e.wav"]}}}',
		);
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.turns).toEqual([{ at: [25, 50, 100], files: [join(projectRoot, "t.wav")] }]);
		expect(config.elapsed).toEqual([{ seconds: [300, 1000], repeat: false, files: [join(projectRoot, "e.wav")] }]);
	});

	it("drops invalid list entries and a block with nothing valid", () => {
		writeProjectSettings(
			'{"sounds": {"turns": {"at": [0, -5, "x", 100], "files": ["t.wav"]}, "elapsed": {"seconds": [null, "soon"], "files": ["e.wav"]}}}',
		);
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.turns).toEqual([{ at: [100], files: [join(projectRoot, "t.wav")] }]);
		expect(config.elapsed).toEqual([]);
	});

	it("accepts a list of blocks, each with its own files", () => {
		writeProjectSettings(
			'{"sounds": {"turns": [{"at": 25, "files": ["a.wav"]}, {"every": 100, "at": [200], "files": ["b.wav"]}], "elapsed": [{"seconds": 300, "repeat": true, "files": ["c.wav"]}, {"seconds": 1000, "files": ["d.wav"]}]}}',
		);
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.turns).toEqual([
			{ at: 25, files: [join(projectRoot, "a.wav")] },
			{ every: 100, at: [200], files: [join(projectRoot, "b.wav")] },
		]);
		expect(config.elapsed).toEqual([
			{ seconds: 300, repeat: true, files: [join(projectRoot, "c.wav")] },
			{ seconds: 1000, repeat: false, files: [join(projectRoot, "d.wav")] },
		]);
	});

	it("drops malformed blocks: missing files, no condition, non-object entries", () => {
		writeProjectSettings(
			'{"sounds": {"turns": [{"every": 5}, {"at": 7, "files": ["t.wav"]}, 42], "elapsed": [{"seconds": 5}, {"seconds": 9, "files": ["e.wav"]}, "nope"]}}',
		);
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.turns).toEqual([{ at: 7, files: [join(projectRoot, "t.wav")] }]);
		expect(config.elapsed).toEqual([{ seconds: 9, repeat: false, files: [join(projectRoot, "e.wav")] }]);
	});

	it("replaces default quotaPatterns with a configured array", () => {
		writeProjectSettings('{"sounds": {"quotaPatterns": ["custom", "patterns"]}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.quotaPatterns).toEqual(["custom", "patterns"]);
	});
});

describe("malformed values fall back per-part without throwing", () => {
	it("sounds as a non-object (string) yields all defaults", () => {
		writeProjectSettings('{"sounds": "yes"}');
		expect(resolveConfig(projectRoot, agentDir)).toEqual(defaultConfig());
	});

	it("non-array event values are dropped (trigger stays silent)", () => {
		writeProjectSettings('{"sounds": {"events": {"promptSubmit": 42}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.promptSubmit).toEqual([]);
	});

	it("unknown sounds.events keys are ignored without throwing", () => {
		writeProjectSettings('{"sounds": {"events": {"mysteryTrigger": ["m.wav"], "agentFailed": ["f.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.agentFailed).toEqual([join(projectRoot, "f.wav")]);
		expect(Object.keys(config.events).sort()).toEqual([
			"agentAborted",
			"agentFailed",
			"agentSettled",
			"agentStart",
			"error",
			"promptSubmit",
			"question",
			"quota",
			"quotaExhausted",
			"sessionStart",
		]);
	});

	it("non-string entries in a file list are dropped", () => {
		writeProjectSettings('{"sounds": {"events": {"promptSubmit": ["ok.wav", 7, null]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.promptSubmit).toEqual([join(projectRoot, "ok.wav")]);
	});

	it("invalid turns/elapsed blocks are ignored", () => {
		writeProjectSettings(
			'{"sounds": {"turns": {"every": "many", "files": ["t.wav"]}, "elapsed": {"seconds": -1, "files": ["e.wav"]}}}',
		);
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.turns).toEqual([]);
		expect(config.elapsed).toEqual([]);
	});

	it("non-array quotaPatterns keeps the defaults", () => {
		writeProjectSettings('{"sounds": {"quotaPatterns": "nope"}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.quotaPatterns).toEqual(DEFAULT_QUOTA_PATTERNS);
	});

	it("non-boolean enabled is ignored", () => {
		writeProjectSettings('{"sounds": {"enabled": "no"}}');
		expect(resolveConfig(projectRoot, agentDir).enabled).toBe(true);
	});
});

/** Stable home-dir helper for assertions: resolveConfig expands ~ against the real home. */
function homedirSafe(): string {
	return homedir();
}
