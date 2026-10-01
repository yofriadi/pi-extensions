/**
 * Synchronous-flush ordering invariant against the real SDK (task 3.9,
 * design D1/D6).
 *
 * `flushTraces` is deliberately NOT stubbed here: the stub replaces the very
 * function whose call timing is the invariant, so it cannot detect the
 * regression this test guards against. Instead the real MlflowSpanProcessor /
 * MlflowSpanExporter run against a local HTTP server whose responses are held
 * until the test releases them — only the HTTP layer is under test control.
 *
 * The invariant: `endRootCycle` ends the root span and starts the flush in the
 * same synchronous job, so the exporter's `Object.values(_pendingExports)`
 * snapshot in `forceFlush` is taken before any previously-abandoned flush can
 * resolve and wipe that map (`_pendingExports = {}`). If an `await` is ever
 * inserted between the root end and the flush start (e.g. "await the retained
 * flush first for clarity"), an abandoned flush resolving in that window wipes
 * the map and the fresh flush snapshots nothing, resolving immediately and
 * reporting a completed cycle it never awaited.
 *
 * The window is reproduced by having cycle 1's export held mid-request when it
 * is abandoned, then releasing its response and firing cycle 2's settle in
 * the same synchronous turn: the response can only be processed by the event
 * loop after that turn, so a correctly synchronous flush still snapshots both
 * the abandoned export's entry and the just-ended root's. A yield inserted
 * before the flush lets the wipe land first.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as mlflow from "mlflow-tracing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SERVER_WAIT_GRACE_MS } from "../src/constants.ts";
import { registerLifecycleHandlers } from "../src/lifecycle.ts";
import { createInitialState } from "../src/state.ts";

/**
 * Minimal in-test double for `ExtensionAPI`: records handlers registered via
 * `on(event, handler)` so tests can fire pi lifecycle events directly without
 * spinning up a real pi session.
 */
class FakeExtensionAPI {
	private handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();

	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	async fire(event: string, payload: unknown, ctx: unknown = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}
}

function makeCtx(sessionId = "session-1") {
	return { sessionManager: { getSessionId: () => sessionId } };
}

/**
 * Local tracking server that holds every response until the test releases it,
 * giving the test exact control over when each real export's HTTP round trip
 * completes. Released requests are answered with HTTP 500 so their export
 * settles (and fails — best-effort, no WAL) without a follow-up artifact
 * upload request, keeping one held request per abandoned cycle.
 */
class HoldingServer {
	private held: http.ServerResponse[] = [];
	private server?: http.Server;
	url = "";

	async start(): Promise<void> {
		this.server = http.createServer((req, res) => {
			req.resume(); // drain the small request body
			this.held.push(res);
		});
		await new Promise<void>((resolve) => {
			this.server?.listen(0, "127.0.0.1", resolve);
		});
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	get heldCount(): number {
		return this.held.length;
	}

	release(index: number): void {
		const res = this.held[index];
		if (!res || res.writableEnded) return;
		res.statusCode = 500;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ error: "held by test" }));
	}

	releaseAll(): void {
		for (let i = 0; i < this.held.length; i++) this.release(i);
	}

	async close(): Promise<void> {
		this.releaseAll();
		await new Promise<void>((resolve) => {
			this.server?.close(() => resolve());
		});
	}
}

const server = new HoldingServer();

/** Drain the microtask queue: `setImmediate` runs only after it is empty. */
function flushMicrotasks(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Run real event-loop turns so held/released socket I/O can be processed. */
async function flushMacrotasks(rounds = 25): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

beforeAll(async () => {
	await server.start();
	// Real SDK and real flushTraces; only the HTTP responses are test-held.
	mlflow.init({ trackingUri: server.url, experimentId: "0" });
});

afterAll(async () => {
	await server.close();
});

describe("synchronous flush ordering vs an abandoned flush (D1/D6, task 3.9)", () => {
	it("keeps the just-ended root's export in the fresh flush's snapshot when an abandoned flush resolves between cycles", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const pi = new FakeExtensionAPI();
			const state = createInitialState({
				trackingUri: server.url,
				experimentName: "ordering",
				captureContent: false,
			});
			state.enabled = true;
			registerLifecycleHandlers(pi as never, state);

			// Cycle 1: its real export's StartTrace request is held by the
			// server, so the settle flush cannot finish within the bound.
			await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
			let settledOne = false;
			const settleOne = pi.fire("agent_settled", { type: "agent_settled" }).then(() => {
				settledOne = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(settledOne).toBe(false);
			await vi.advanceTimersByTimeAsync(SERVER_WAIT_GRACE_MS);
			expect(settledOne).toBe(true);
			await settleOne;
			expect(state.flushWaitExceeded).toBe(true);
			expect(state.pendingFlush).toBeDefined();
			await flushMacrotasks();
			expect(server.heldCount).toBe(1);

			// Cycle 2 opens a new root.
			await pi.fire("agent_start", { type: "agent_start" }, makeCtx());

			// Cycle 1's abandoned export is released and cycle 2 settles within
			// the same synchronous turn, so no event-loop processing can run
			// between the root end and the flush call. The fresh flush's
			// snapshot must therefore still contain the abandoned export's
			// entry alongside cycle 2's just-queued one.
			server.release(0);
			let settledTwo = false;
			const settleTwo = pi.fire("agent_settled", { type: "agent_settled" }).then(() => {
				settledTwo = true;
			});
			// Real I/O now runs: cycle 1's response arrives, its export settles,
			// and the abandoned forceFlush wipes the pending map — but no fake
			// time has passed and cycle 2's request is still held.
			await flushMacrotasks();
			expect(server.heldCount).toBe(2);
			expect(settledTwo).toBe(false);
			expect(state.flushWaitExceeded).toBe(true);

			// Only the grace bound ends the wait: the fresh flush really
			// observed cycle 2's export instead of snapshotting an empty map
			// (which would resolve immediately with a bogus "completed").
			await vi.advanceTimersByTimeAsync(SERVER_WAIT_GRACE_MS);
			expect(settledTwo).toBe(true);
			await settleTwo;
			expect(state.flushWaitExceeded).toBe(true);
			expect(state.pendingFlush).toBeDefined();

			// Completing cycle 2's export lets the next attempt finish within
			// the bound and clear the degraded state.
			server.release(1);
			await flushMacrotasks();
			let settledThree = false;
			const settleThree = pi.fire("agent_settled", { type: "agent_settled" }).then(() => {
				settledThree = true;
			});
			await flushMicrotasks();
			expect(settledThree).toBe(true);
			await settleThree;
			expect(state.flushWaitExceeded).toBe(false);
			expect(state.pendingFlush).toBeUndefined();
		} finally {
			server.releaseAll();
			vi.useRealTimers();
		}
	});
});
