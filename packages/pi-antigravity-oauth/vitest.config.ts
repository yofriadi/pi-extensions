import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Reuses the source TS files directly — this package is source-only,
		// no build step. The Pi runtime loads ./src/index.ts via jiti.
		environment: "node",
		// The hang-reproduction tests race the implementation against a
		// 10-15s inner timeout, and the pollOperation-never-done test takes
		// ~30s to complete. The default 5000ms would kill them before they
		// can assert.
		testTimeout: 90_000,
	},
});
