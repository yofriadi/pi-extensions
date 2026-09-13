import { defineConfig } from "vitest/config";

/**
 * Opt-in integration suite: exercises the real `mcporter` transport against a
 * real tilth MCP server (ad-hoc `npx tilth --mcp`). Requires network access and
 * is never run by the default `pnpm test`.
 */
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		testTimeout: 90_000,
		hookTimeout: 120_000,
	},
});
