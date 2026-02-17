import { describe, expect, it } from "vitest";
import { ReviewStateStore } from "../src/state.js";

describe("review state store", () => {
	it("evicts expired states by TTL", () => {
		let now = 0;
		const store = new ReviewStateStore(10, 100, () => now);

		store.get("s1");
		now = 20;
		store.get("s2");

		expect(store.size()).toBe(1);
	});

	it("evicts oldest when max entries exceeded", () => {
		let now = 0;
		const store = new ReviewStateStore(1_000_000, 2, () => now);

		store.get("s1");
		now = 1;
		store.get("s2");
		now = 2;
		store.get("s3");

		expect(store.size()).toBe(2);
		expect(store.has("s1")).toBe(false);
		expect(store.has("s2")).toBe(true);
		expect(store.has("s3")).toBe(true);
	});
});
