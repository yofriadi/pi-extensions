import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TRACKING_URI, defaultExperimentName, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-mlflow-config-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns defaults when no config file exists", async () => {
		const config = await loadConfig(dir);
		expect(config).toEqual({
			trackingUri: "http://localhost:5055",
			experimentName: basename(dir),
			captureContent: true,
		});
	});

	it("pins the default tracking URI to the documented contract", () => {
		expect(DEFAULT_TRACKING_URI).toBe("http://localhost:5055");
	});

	it("reads and validates an explicit config file", async () => {
		await writeFile(
			join(dir, "pi-mlflow.json"),
			JSON.stringify({
				trackingUri: "http://example.com:5000",
				experimentName: "my-experiment",
				captureContent: true,
			}),
		);
		const config = await loadConfig(dir);
		expect(config).toEqual({
			trackingUri: "http://example.com:5000",
			experimentName: "my-experiment",
			captureContent: true,
		});
	});

	it("fills in defaults for partially specified config", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ captureContent: false }));
		const config = await loadConfig(dir);
		expect(config).toEqual({
			trackingUri: "http://localhost:5055",
			experimentName: basename(dir),
			captureContent: false,
		});
	});

	it('falls back to "pi" when the resolved working directory basename is empty', () => {
		expect(defaultExperimentName("/")).toBe("pi");
		expect(defaultExperimentName("////")).toBe("pi");
	});
	it("resolves trailing separators and parent/dot segments before deriving the directory name", () => {
		expect(defaultExperimentName(`${dir}/`)).toBe(basename(dir));
		// Unresolved input: resolve() collapses `..` and `.`, so the basename is
		// the directory name. A bare `basename(cwd)` (no resolve) would return ".",
		// so this pins the resolve() step against a regression to basename(cwd).
		expect(defaultExperimentName(`${dir}/../${basename(dir)}/.`)).toBe(basename(dir));
	});

	it("lets explicit experimentName and captureContent: false override the defaults", async () => {
		await writeFile(
			join(dir, "pi-mlflow.json"),
			JSON.stringify({ experimentName: "explicit-name", captureContent: false }),
		);
		const config = await loadConfig(dir);
		expect(config).toEqual({
			trackingUri: "http://localhost:5055",
			experimentName: "explicit-name",
			captureContent: false,
		});
	});

	it("rejects an explicit empty-string experimentName (absent is not empty)", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ experimentName: "" }));
		await expect(loadConfig(dir)).rejects.toThrow(/experimentName/);
	});

	it("throws on malformed JSON so the caller can fold it into silent-disable", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), "{not json");
		await expect(loadConfig(dir)).rejects.toThrow();
	});

	it("throws when captureContent is not a boolean", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ captureContent: "yes" }));
		await expect(loadConfig(dir)).rejects.toThrow(/captureContent/);
	});

	it("throws on unknown config fields so a typo surfaces instead of silent default", async () => {
		await writeFile(
			join(dir, "pi-mlflow.json"),
			JSON.stringify({ trackingUri: "http://example.com:5000", trakcingUri: "http://typo" }),
		);
		await expect(loadConfig(dir)).rejects.toThrow(/unknown config field\(s\): trakcingUri/);
	});

	it("throws when the config root is not a plain object (array)", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify([]));
		await expect(loadConfig(dir)).rejects.toThrow(/config root must be a JSON object/);
	});

	it("throws when the config root is a non-object primitive", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify(7));
		await expect(loadConfig(dir)).rejects.toThrow(/config root must be a JSON object/);
	});

	it("throws when the config root is null", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), "null");
		await expect(loadConfig(dir)).rejects.toThrow(/config root must be a JSON object/);
	});

	it("rejects trackingUri credentials so they cannot leak via request/timeout errors", async () => {
		await writeFile(
			join(dir, "pi-mlflow.json"),
			JSON.stringify({ trackingUri: "http://user:secret@localhost:5000" }),
		);
		await expect(loadConfig(dir)).rejects.toThrow(/must not contain credentials/i);
	});

	it("rejects non-http(s) trackingUri schemes", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ trackingUri: "file:///tmp/mlruns" }));
		await expect(loadConfig(dir)).rejects.toThrow(/http or https/i);
	});

	it("rejects invalid trackingUri values", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ trackingUri: "not a url" }));
		await expect(loadConfig(dir)).rejects.toThrow(/valid absolute HTTP\(S\) URL/i);
	});
});
