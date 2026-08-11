import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ForegroundDeliveryBarrier,
	getForegroundDeliveryBarrier,
	retryAcceptedDelivery,
} from "../src/delivery-barrier.ts";

describe("foreground delivery barrier", () => {
	it("holds background deliveries until all queued/active foreground leases release", async () => {
		const barrier = new ForegroundDeliveryBarrier();
		const first = barrier.enter();
		const second = barrier.enter();
		const sent: string[] = [];
		const a = barrier.deliver((wake) => {
			sent.push(`a:${wake}`);
		});
		const b = barrier.deliver((wake) => {
			sent.push(`b:${wake}`);
		});
		first.release();
		assert.deepEqual(sent, []);
		second.release();
		await Promise.all([a, b]);
		assert.deepEqual(sent, ["a:false", "b:true"]);
	});

	it("returns a blocking result before one background wake-up", async () => {
		const barrier = new ForegroundDeliveryBarrier();
		const foreground = barrier.enter();
		const order: string[] = [];
		const pending = barrier.deliver((wake) => {
			order.push(`background:${wake}`);
		});
		order.push("blocking-result");
		foreground.release();
		await pending;
		assert.deepEqual(order, ["blocking-result", "background:true"]);
	});

	it("retries failed API acceptance within a bounded budget", async () => {
		let calls = 0;
		await retryAcceptedDelivery(
			() => {
				calls++;
				if (calls < 3) throw new Error("temporary");
			},
			{ attempts: 3, delayMs: 0 },
		);
		assert.equal(calls, 3);

		calls = 0;
		await assert.rejects(
			retryAcceptedDelivery(
				() => {
					calls++;
					throw new Error("permanent");
				},
				{ attempts: 2, delayMs: 0 },
			),
			/permanent/,
		);
		assert.equal(calls, 2);
	});

	it("flushes simultaneous async completions in settlement order with one wake", async () => {
		const barrier = new ForegroundDeliveryBarrier();
		const foreground = barrier.enter();
		const sent: string[] = [];
		const deliveries = ["result-a", "result-b", "result-c"].map((name) =>
			barrier.deliver((wake) => {
				sent.push(`${name}:${wake}`);
			}),
		);
		foreground.release();
		await Promise.all(deliveries);
		assert.deepEqual(sent, ["result-a:false", "result-b:false", "result-c:true"]);
	});

	it("keeps failed acceptance pending until bounded retry rejects and supports shutdown suppression", async () => {
		const barrier = new ForegroundDeliveryBarrier();
		const foreground = barrier.enter();
		const pending = barrier.deliver(() => {
			throw new Error("api unavailable");
		});
		foreground.release();
		await assert.rejects(pending, /api unavailable/);

		const second = new ForegroundDeliveryBarrier();
		second.enter();
		const suppressed = second.deliver(() => {});
		second.suppressPending("shutdown");
		await assert.rejects(suppressed, /shutdown/);
	});

	it("reconciles leaked foreground ownership and flushes the held result", async () => {
		const barrier = new ForegroundDeliveryBarrier();
		barrier.enter("stale-run");
		const sent: boolean[] = [];
		const pending = barrier.deliver((wake) => {
			sent.push(wake);
		});
		barrier.reconcileActive([]);
		await pending;
		assert.deepEqual(sent, [true]);
		assert.equal(barrier.isActive(), false);
	});

	it("makes shutdown suppression sticky for later and in-flight delivery", async () => {
		const barrier = new ForegroundDeliveryBarrier();
		barrier.suppressPending("shutdown");
		await assert.rejects(
			barrier.deliver(() => {}),
			/shutdown/,
		);
		assert.throws(() => barrier.enter("late"), /shutdown/);
	});

	it("keeps a follower in the same stable drain batch when the first send yields", async () => {
		const barrier = new ForegroundDeliveryBarrier();
		const foreground = barrier.enter();
		const sent: boolean[] = [];
		const first = barrier.deliver(async (wake) => {
			sent.push(wake);
			await Promise.resolve();
		});
		foreground.release();
		const second = barrier.deliver((wake) => {
			sent.push(wake);
		});
		await Promise.all([first, second]);
		assert.deepEqual(sent, [false, true]);
	});

	it("replaces migrated foreground ownership with the exact active set", () => {
		const barrier = new ForegroundDeliveryBarrier();
		barrier.enter("old");
		barrier.reconcileActive(["new"]);
		assert.equal(barrier.isActive(), true);
		barrier.reconcileActive([]);
		assert.equal(barrier.isActive(), false);
	});

	it("uses one process-global barrier per parent session", () => {
		assert.equal(getForegroundDeliveryBarrier("barrier-parent"), getForegroundDeliveryBarrier("barrier-parent"));
		assert.notEqual(getForegroundDeliveryBarrier("barrier-parent"), getForegroundDeliveryBarrier("other"));
	});

	it("a mid-drain failure of the positional wake slot cannot strand an accepted sibling's wake", async () => {
		// Regression: the barrier assigns its wake slot positionally to the final
		// queued callback. If an earlier send was ACCEPTED (wake=false) and the
		// final callback then fails (e.g. the session-bound runtime disappeared
		// mid-drain), no callback claims the wake — the accepted sibling's steer
		// can sit unpersisted against an idle parent. Delivery must wake from the
		// last ACCEPTED send, not from the positional slot. This barrier-level
		// case proves the failure mode exists; src/index.ts makes every accepted
		// idle send wake-eligible through the deduplicated wake path.
		const barrier = new ForegroundDeliveryBarrier();
		const foreground = barrier.enter();
		const wakeFlags: boolean[] = [];
		const accepted = barrier.deliver((wake) => {
			wakeFlags.push(wake);
			// wake=false: the accepted send does NOT own the positional slot.
		});
		const failing = barrier.deliver((wake) => {
			wakeFlags.push(wake);
			throw new Error("runtime deactivated mid-drain");
		});
		foreground.release();
		await accepted;
		await assert.rejects(failing, /runtime deactivated mid-drain/);
		// retryAcceptedDelivery invokes a failed callback three times; only the
		// final queued callback receives the positional wake flag.
		assert.deepEqual(wakeFlags, [false, true, true, true]);
	});
});
