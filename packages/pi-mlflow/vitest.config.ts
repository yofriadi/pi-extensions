import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		// Real-server suite is opt-in via `npm run test:integration` (needs mlflow server).
		exclude: ["test/**/*.integration.test.ts"],
	},
});
