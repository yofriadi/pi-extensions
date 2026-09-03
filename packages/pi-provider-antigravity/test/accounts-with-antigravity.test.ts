import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const accountsPackageDir = join(packageDir, "..", "pi-accounts");

// Pi 0.79 exposes discoverAndLoadExtensions publicly; it resolves package manifests
// and delegates to its internal loadExtensions implementation with one EventBus.
describe("accounts-with-antigravity composition host", () => {
	let agentDir: string;

	afterEach(() => {
		vi.unstubAllEnvs();
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	});

	it("discovers both package entrypoints and composes /accounts exactly once", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-antigravity-loader-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		const result = await discoverAndLoadExtensions(
			[
				join(accountsPackageDir, "src", "accounts.ts"),
				join(packageDir, "src", "index.ts"),
				join(packageDir, "src", "accounts-with-antigravity.ts"),
			],
			packageDir,
			agentDir,
			createEventBus(),
		);

		expect(result.errors).toEqual([]);
		expect(result.extensions.map((extension) => extension.path)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/pi-accounts\/src\/accounts\.ts$/),
				expect.stringMatching(/pi-provider-antigravity\/src\/index\.ts$/),
				expect.stringMatching(/pi-provider-antigravity\/src\/accounts-with-antigravity\.ts$/),
			]),
		);
		expect(result.extensions.flatMap((extension) => [...extension.commands.keys()])).toEqual(["accounts"]);
		expect(result.extensions.filter((extension) => extension.handlers.has("session_start"))).toHaveLength(1);
		expect(result.runtime.pendingProviderRegistrations).toHaveLength(1);
		expect(result.runtime.pendingProviderRegistrations[0]?.name).toBe("google-antigravity");
	});
});
