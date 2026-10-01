/**
 * Loader-level integration: the package is discovered through its
 * pi.extensions manifest and the --no-sounds flag is registered via the
 * real loader path (no loader mocking), per repo test policy.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");
const extensionPath = join(packageRoot, "src", "index.ts");

let agentDir: string | undefined;

afterEach(() => {
	if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	agentDir = undefined;
});

describe("pi-event-sounds — loader integration", () => {
	it("is discovered and registers the --no-sounds flag", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-sounds-loader-"));
		const result = await discoverAndLoadExtensions([packageRoot], packageRoot, agentDir);
		expect(result.errors).toEqual([]);

		const extension = result.extensions.find((ext) => ext.path === extensionPath);
		expect(extension).toBeDefined();

		// Registration went through the real loader.
		expect([...(extension?.flags.keys() ?? [])]).toEqual(["no-sounds"]);
		const flag = extension?.flags.get("no-sounds");
		expect(flag?.type).toBe("boolean");
		expect(flag?.default).toBe(false);
		expect(flag?.description?.length).toBeGreaterThan(0);
	});

	it("is discovered and registers both /sounds and /event-sounds", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-sounds-loader-"));
		const result = await discoverAndLoadExtensions([packageRoot], packageRoot, agentDir);
		expect(result.errors).toEqual([]);

		const extension = result.extensions.find((ext) => ext.path === extensionPath);
		expect(extension).toBeDefined();

		// Both command names share one options object (loader stores
		// name + sourceInfo + the registered options).
		expect([...(extension?.commands.keys() ?? [])].sort()).toEqual(["event-sounds", "sounds"]);
		for (const command of extension?.commands.values() ?? []) {
			expect(command.description?.length).toBeGreaterThan(0);
			expect(command.handler).toBeTypeOf("function");
		}
	});

	it("subscribes to every sound-bearing lifecycle event", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-sounds-loader-"));
		const result = await discoverAndLoadExtensions([packageRoot], packageRoot, agentDir);
		expect(result.errors).toEqual([]);

		const extension = result.extensions.find((ext) => ext.path === extensionPath);
		const handlers = [...(extension?.handlers.keys() ?? [])].sort();
		expect(handlers).toEqual([
			"agent_end",
			"agent_settled",
			"agent_start",
			"input",
			"message_end",
			"session_shutdown",
			"session_start",
			"tool_result",
			"turn_start",
			"ui_prompt_start",
		]);
	});
});
