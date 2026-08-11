import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("symbol key rename", () => {
	it("uses pi-subagent-herdr/* Symbol.for keys and no pi-subagents/ keys", () => {
		const index = readFileSync(join(root, "src/index.ts"), "utf8");
		const state = readFileSync(join(root, "src/state.ts"), "utf8");
		const layout = readFileSync(join(root, "src/layout.ts"), "utf8");
		assert.match(state, /Symbol\.for\("pi-subagent-herdr\/widget-interval"\)/);
		assert.match(state, /Symbol\.for\("pi-subagent-herdr\/status-interval"\)/);
		assert.match(state, /Symbol\.for\("pi-subagent-herdr\/runtime"\)/);
		assert.match(layout, /Symbol\.for\("pi-subagent-herdr\/layout"\)/);
		assert.doesNotMatch(index, /Symbol\.for\("pi-subagents\//);
		assert.doesNotMatch(state, /Symbol\.for\("pi-subagents\//);
		assert.doesNotMatch(layout, /Symbol\.for\("pi-subagents\//);
	});
});
