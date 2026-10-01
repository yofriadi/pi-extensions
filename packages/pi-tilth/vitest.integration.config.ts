import { defineConfig } from "vitest/config";

/**
 * Opt-in integration suite: exercises the real in-process MCP transport
 * (`McpClient` + `StdioTransport` from `@earendil-works/pi-mcp`) against a
 * real tilth MCP server (`tilth --mcp` on PATH, `npx -y tilth --mcp`
 * fallback). Requires the tilth binary (or network access on a cold npx
 * cache) and is never run by the default `pnpm test`.
 */
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		testTimeout: 90_000,
		hookTimeout: 120_000,
	},
});
