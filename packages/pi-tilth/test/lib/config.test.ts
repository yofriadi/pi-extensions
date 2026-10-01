import { describe, expect, it } from "vitest";
import { loadConfig, normalizeConfig } from "../../src/lib/config";

describe("config — loading and precedence", () => {
	it("normalizes unknown fields away and keeps valid ones", () => {
		const c = normalizeConfig({
			// serverName was a mcporter-era key; it must now be dropped.
			serverName: "custom",
			connectTimeoutMs: 5_000,
			callTimeoutMs: 120_000,
			hashlineCompat: false,
			nonsense: true,
		});
		expect(c).toEqual({
			connectTimeoutMs: 5_000,
			callTimeoutMs: 120_000,
			hashlineCompat: false,
		});
	});

	it("rejects garbage types", () => {
		const c = normalizeConfig({ connectTimeoutMs: "x", callTimeoutMs: "x", hashlineCompat: "yes" });
		expect(c).toEqual({});
	});

	it("rejects non-positive and non-finite connectTimeoutMs", () => {
		expect(normalizeConfig({ connectTimeoutMs: 0 })).toEqual({});
		expect(normalizeConfig({ connectTimeoutMs: -1 })).toEqual({});
		expect(normalizeConfig({ connectTimeoutMs: Number.POSITIVE_INFINITY })).toEqual({});
	});

	it("defaults callTimeoutMs and hashlineCompat when no config file exists", () => {
		const config = loadConfig({
			globalConfigPath: "/nonexistent-global.json",
			projectConfigPath: "/nonexistent-project.json",
		});
		expect(config).toEqual({
			callTimeoutMs: 60_000,
			hashlineCompat: true,
		});
	});

	it("omits connectTimeoutMs when unset so the transport derives it from the mode", () => {
		const config = loadConfig({
			globalConfigPath: "/nonexistent-global.json",
			projectConfigPath: "/nonexistent-project.json",
		});
		expect("connectTimeoutMs" in config).toBe(false);
	});
});
