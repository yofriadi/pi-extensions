import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");

/**
 * Loader-level integration: the package is discovered through its
 * pi.extensions manifest and registers all six tools + /tilth-savings
 * through the real loader path (no loader mocking).
 */
describe("pi-tilth — loader integration", () => {
	it("is discovered and registers six tools and the savings command", async () => {
		const agentDir = join(packageRoot, "test", ".tmp-agent");
		const result = await discoverAndLoadExtensions([packageRoot], packageRoot, agentDir);
		expect(result.errors).toEqual([]);

		const extension = result.extensions.find((ext) => ext.path === join(packageRoot, "src", "index.ts"));
		expect(extension).toBeDefined();

		// Registration surface went through the real loader.
		expect([...(extension?.tools.keys() ?? [])].sort()).toEqual([
			"tilth_deps",
			"tilth_diff",
			"tilth_grok",
			"tilth_list",
			"tilth_read",
			"tilth_search",
		]);
		expect([...(extension?.commands.keys() ?? [])]).toEqual(["tilth-savings"]);
	});

	it("v1 compat scope: only tilth_read output is hashline-annotated", () => {
		// tilth-tools spec Scenario "Search expansion passes through": in v1 only
		// tilth_read output is annotated (design D7 scope). This locks the
		// registration flag so a future tool cannot silently opt in.
		// registerTilthTool's annotate option drives annotateReadOutput inside
		// execute — its effect is structural (only read.ts passes annotate: true),
		// asserted here at the source level for v1.
		const readSource = readFileSync(join(packageRoot, "src", "tools", "read.ts"), "utf-8");
		const otherToolSources = ["search", "list", "deps", "grok", "diff"]
			.map((name) => readFileSync(join(packageRoot, "src", "tools", `${name}.ts`), "utf-8"))
			.join("\n");
		expect(readSource).toContain("annotate: true");
		expect(otherToolSources).not.toContain("annotate: true");
	});
});
