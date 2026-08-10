import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	abortAllLaunchTransactions,
	beginLaunchTransaction,
	finishLaunchTransaction,
	getLaunchTransactions,
	LaunchTransaction,
} from "../src/launch-transaction.ts";

const FAILURE_POINTS = [
	"validation",
	"split",
	"missing pane ID",
	"script write",
	"pane run",
	"watcher registration",
	"manual close",
] as const;

describe("launch transaction failure injection", () => {
	for (const failurePoint of FAILURE_POINTS) {
		it(`rolls back exactly once after ${failurePoint}`, () => {
			const transaction = new LaunchTransaction();
			const cleanup: string[] = [];
			transaction.own(() => cleanup.push("capacity"));
			transaction.own(() => cleanup.push("lease"));
			if (failurePoint !== "validation") {
				transaction.advance("pane");
				transaction.own(() => cleanup.push("region"));
				transaction.own(() => cleanup.push("pane"));
			}
			if (!["validation", "split", "missing pane ID"].includes(failurePoint)) {
				transaction.advance("script");
				transaction.own(() => cleanup.push("script"));
			}
			if (failurePoint === "watcher registration" || failurePoint === "manual close") {
				transaction.advance("watcher");
				transaction.own(() => cleanup.push("watcher"));
			}
			transaction.rollback();
			transaction.rollback();
			assert.equal(new Set(cleanup).size, cleanup.length);
			assert.ok(cleanup.includes("capacity"));
			assert.ok(cleanup.includes("lease"));
			if (failurePoint !== "validation") assert.ok(cleanup.includes("pane"));
		});
	}

	it("committed running launch does not execute rollback", () => {
		const transaction = new LaunchTransaction();
		let cleaned = 0;
		transaction.own(() => cleaned++);
		transaction.advance("pane");
		transaction.advance("script");
		transaction.advance("watcher");
		transaction.commit();
		transaction.rollback();
		assert.equal(cleaned, 0);
		assert.equal(transaction.step, "running");
	});

	it("rollback releases capacity so the next queued launch can admit", async () => {
		const { AdmissionCoordinator } = await import("../src/coordinator.ts");
		const coordinator = new AdmissionCoordinator();
		const first = coordinator.request({ id: "failed", class: "foreground" });
		const next = coordinator.request({ id: "next", class: "foreground" });
		const transaction = new LaunchTransaction();
		transaction.own(() => first.lease.release());
		transaction.rollback();
		assert.equal((await next.admitted).id, "next");
	});

	it("registers admitted production ownership and aborts all in-flight launches", () => {
		const first = beginLaunchTransaction("live-first");
		const second = beginLaunchTransaction("live-second");
		let cleaned = 0;
		first.own(() => cleaned++);
		second.own(() => cleaned++);
		assert.equal(getLaunchTransactions().size >= 2, true);
		abortAllLaunchTransactions();
		assert.equal(cleaned, 2);
		assert.equal(first.signal.aborted, true);
		assert.equal(second.signal.aborted, true);
		finishLaunchTransaction("live-first", first);
		finishLaunchTransaction("live-second", second);
	});
});
