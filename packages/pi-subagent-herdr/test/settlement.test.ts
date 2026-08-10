import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSettlementRegistry, SettlementRegistry } from "../src/settlement.ts";

describe("settlement registry", () => {
	it("atomically claims each run once", () => {
		const registry = new SettlementRegistry();
		assert.deepEqual(registry.claim("run", "sidecar", 10), { runId: "run", source: "sidecar", claimedAt: 10 });
		assert.equal(registry.claim("run", "sentinel", 11), null);
		assert.equal(registry.get("run")?.source, "sidecar");
		registry.clear("run");
		assert.equal(registry.claim("run", "pane-disappearance", 12)?.source, "pane-disappearance");
	});

	it("reuses a process-global registry per parent session", () => {
		assert.equal(getSettlementRegistry("settlement-parent"), getSettlementRegistry("settlement-parent"));
		assert.notEqual(getSettlementRegistry("settlement-parent"), getSettlementRegistry("other"));
	});
});
