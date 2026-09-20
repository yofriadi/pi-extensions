import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: [...configDefaults.exclude],
		testTimeout: 30_000,
		hookTimeout: 10_000,
		sequence: {
			hooks: "list",
		},
		server: {
			deps: {
				external: [/\/src\//],
			},
		},
	},
});
