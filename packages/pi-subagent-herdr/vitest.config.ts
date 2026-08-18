import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));
const nodeTestShim = resolve(here, "test/alias.js");

export default defineConfig({
	test: {
		include: ["test/test.ts", "test/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "test/integration/**"],
		testTimeout: 30_000,
		hookTimeout: 10_000,
		sequence: {
			hooks: "list",
		},
		pool: "forks",
		poolOptions: {
			forks: { singleFork: true },
		},
		isolate: false,
		server: {
			deps: {
				external: [/\/src\//],
			},
		},
	},
	resolve: {
		alias: {
			"node:test": nodeTestShim,
		},
	},
	plugins: [
		{
			name: "alias-node-test",
			enforce: "pre",
			resolveId(id) {
				if (id === "node:test") {
					return nodeTestShim;
				}
			},
		},
	],
});
