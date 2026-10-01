import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureHealthyAdmissionCoordinator, getAdmissionCoordinator } from "../src/coordinator.ts";
import { ensureHealthyForegroundDeliveryBarrier, getForegroundDeliveryBarrier } from "../src/delivery-barrier.ts";
import subagentsExtension, * as subagentsModule from "../src/index.ts";
import { createLifecycle, markDelivery } from "../src/lifecycle.ts";

const testApi = (subagentsModule as any).__test__;
const { settleParentShutdown, shouldDeliverSubagentCompletion } = subagentsModule;

/** Fake ExtensionAPI with handler capture, mirroring Pi's factory contract. */
function fakeExtensionPi() {
	const handlers: Record<string, Function> = {};
	const pi: any = {
		handlers,
		on(name: string, fn: Function) {
			handlers[name] = fn;
		},
		registerTool() {},
		registerMessageRenderer() {},
	};
	return pi;
}

function fakeCtx(sessionId: string) {
	return {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
			getSessionDir: () => "/tmp",
		},
		ui: { setWidget() {} },
		isProjectTrusted: () => true,
	};
}

/** Unique-per-run session ids keep the process-global registries isolated. */
function freshSessionId(label: string): string {
	return `revival-${label}-${Date.now()}-${Math.random()}`;
}

/** Poison session X's singletons the way a real terminal switch-out does. */
function poisonSession(sessionId: string): void {
	const queued = new Map<string, any>([
		[
			"queued-run",
			{
				id: "queued-run",
				admissionClass: "background",
				cancel: () => true,
			},
		],
	]);
	const running = new Map<string, any>([
		[
			"running-run",
			{
				id: "running-run",
				admissionClass: "background",
				abortController: new AbortController(),
				lifecycle: createLifecycle(Date.now()),
				foregroundBarrierLease: undefined,
			},
		],
	]);
	const pending = new Map<string, any>([["pending-run", { id: "pending-run", exhausted: false }]]);
	settleParentShutdown(
		"resume",
		sessionId,
		{ queued, running, pending },
		{
			safeClose: () => {},
			release: () => {},
			abortTransactions: () => {},
		},
	);
}

/** Assert the session is spawnable: admission succeeds and the barrier enters. */
function assertSpawnable(sessionId: string): void {
	const coordinator = getAdmissionCoordinator(sessionId);
	const ticket = coordinator.request({ id: `probe-${Date.now()}-${Math.random()}`, class: "background" });
	assert.equal(ticket.queued, false, "admission accepted after revival");
	ticket.lease.release();
	const barrier = getForegroundDeliveryBarrier(sessionId);
	const lease = barrier.enter(`probe-${Date.now()}-${Math.random()}`);
	lease.release();
}

describe("session-keyed singleton revival on session_start", () => {
	it("revives singletons poisoned by a terminal shutdown of the same session identity", () => {
		const sessionId = freshSessionId("reported-failure");
		// Baseline: a first activation is healthy and spawnable.
		const pi = fakeExtensionPi();
		subagentsExtension(pi);
		pi.handlers.session_start({}, fakeCtx(sessionId));
		assertSpawnable(sessionId);

		// Switch away (resume/fork/new): Pi guarantees the terminal shutdown of
		// this session identity happens BEFORE the replacement's session_start.
		poisonSession(sessionId);
		assert.throws(
			() => getAdmissionCoordinator(sessionId).request({ id: "late-admission", class: "background" }),
			/shut down/,
		);
		assert.throws(
			() => getForegroundDeliveryBarrier(sessionId).enter("late-foreground"),
			/suppressed during shutdown/,
		);

		// Resume back: same session identity, session_start must revive both.
		pi.handlers.session_start({}, fakeCtx(sessionId));
		assertSpawnable(sessionId);
		// No "Subagent coordinator is shut down." / "Subagent delivery suppressed
		// during shutdown." — the fresh instances are the registry entries.
		assert.equal(getAdmissionCoordinator(sessionId).isShutDown(), false);
		assert.equal(getForegroundDeliveryBarrier(sessionId).isSuppressed(), false);
	});

	it("keeps healthy singletons and their active background lease across session_start", () => {
		const sessionId = freshSessionId("reload-survival");
		const pi = fakeExtensionPi();
		subagentsExtension(pi);
		pi.handlers.session_start({}, fakeCtx(sessionId));

		// A healthy coordinator holding a live background lease, an unsuppressed
		// barrier — the /reload adoption shape.
		const coordinator = getAdmissionCoordinator(sessionId);
		const lease = coordinator.request({ id: "background-lease", class: "background" }).lease;
		const barrier = getForegroundDeliveryBarrier(sessionId);
		assert.equal(lease.state, "admitted");

		pi.handlers.session_start({}, fakeCtx(sessionId));

		// Identity preserved: no eviction, the lease remains current.
		assert.equal(getAdmissionCoordinator(sessionId), coordinator);
		assert.equal(getForegroundDeliveryBarrier(sessionId), barrier);
		assert.equal(coordinator.isAdmissionCurrent(lease), true);
		lease.release();
	});

	it("keeps a late watcher of a killed run suppressed after revival", () => {
		const sessionId = freshSessionId("fail-closed-late-watcher");
		const pi = fakeExtensionPi();
		subagentsExtension(pi);
		pi.handlers.session_start({}, fakeCtx(sessionId));

		// A run killed at terminal shutdown: its own recorded suppression gate
		// (lifecycle.delivery) must outlive singleton revival.
		const killedRun: any = {
			id: "killed-run",
			admissionClass: "background",
			abortController: new AbortController(),
			lifecycle: createLifecycle(Date.now()),
		};
		const queued = new Map<string, any>();
		const running = new Map<string, any>([["killed-run", killedRun]]);
		const pending = new Map<string, any>();
		settleParentShutdown(
			"resume",
			sessionId,
			{ queued, running, pending },
			{
				safeClose: () => {},
				release: () => {},
				abortTransactions: () => {},
			},
		);
		assert.equal(killedRun.lifecycle.delivery, "suppressed");
		assert.equal(shouldDeliverSubagentCompletion(killedRun), false);

		// Revive; the late watcher still cannot deliver into the re-activated
		// session, and no pending-delivery redrive occurs for it.
		pi.handlers.session_start({}, fakeCtx(sessionId));
		assertSpawnable(sessionId);
		assert.equal(shouldDeliverSubagentCompletion(killedRun), false, "run-level suppression survives revival");
		assert.equal(
			testApi.pendingDeliveries.has(killedRun.id),
			false,
			"no pending-delivery redrive for the killed run",
		);
	});

	it("revives through alternating session switches without accumulation", () => {
		const sessionId = freshSessionId("alternating");
		const pi = fakeExtensionPi();
		subagentsExtension(pi);
		pi.handlers.session_start({}, fakeCtx(sessionId));

		// Simulate A → B → A → B → A: two poison+revive cycles on X. Each revival
		// must produce a distinct fresh instance (old instances are evicted, not
		// accumulated or reused) and a spawnable session.
		let previousCoordinator = getAdmissionCoordinator(sessionId);
		for (let cycle = 0; cycle < 2; cycle++) {
			poisonSession(sessionId);
			assert.throws(
				() => getAdmissionCoordinator(sessionId).request({ id: `late-${cycle}`, class: "background" }),
				/shut down/,
			);
			pi.handlers.session_start({}, fakeCtx(sessionId));
			assertSpawnable(sessionId);
			const revived = getAdmissionCoordinator(sessionId);
			assert.notEqual(revived, previousCoordinator, `cycle ${cycle} produced a fresh coordinator instance`);
			previousCoordinator = revived;
		}

		assert.equal(getAdmissionCoordinator(sessionId).isShutDown(), false);
		assert.equal(getForegroundDeliveryBarrier(sessionId).isSuppressed(), false);
	});

	it("a terminal shutdown AFTER session_start leaves the session terminally shut down (documented order assumption)", () => {
		// Reversed-order guard (design Assumption): today Pi always emits the
		// terminal session_shutdown for a session ID BEFORE the session_start
		// that must heal it. If a future Pi ordering change ever emits a terminal
		// shutdown after revival with no later session_start, the session stays
		// poisoned — asserted here so the assumption breaks loudly, not silently.
		const sessionId = freshSessionId("reversed-order");
		const pi = fakeExtensionPi();
		subagentsExtension(pi);
		pi.handlers.session_start({}, fakeCtx(sessionId));
		assertSpawnable(sessionId);

		poisonSession(sessionId);

		assert.equal(getAdmissionCoordinator(sessionId).isShutDown(), true, "coordinator stays terminally shut down");
		assert.equal(
			getForegroundDeliveryBarrier(sessionId).isSuppressed(),
			true,
			"barrier stays terminally suppressed",
		);
		assert.throws(
			() => getAdmissionCoordinator(sessionId).request({ id: "post-poison", class: "background" }),
			/shut down/,
		);
		assert.throws(() => getForegroundDeliveryBarrier(sessionId).enter("post-poison"), /suppressed during shutdown/);
	});
});

describe("revival helper semantics", () => {
	it("revival replaces the poisoned coordinator instance, not its state", () => {
		const sessionId = freshSessionId("instance-replacement");
		const poisoned = getAdmissionCoordinator(sessionId);
		poisoned.shutdownNow();
		const fresh = ensureHealthyAdmissionCoordinator(sessionId);
		assert.notEqual(fresh, poisoned);
		assert.equal(poisoned.isShutDown(), true, "poisoned instance retains its terminal state");
	});

	it("revival replaces the suppressed barrier instance, not its state", () => {
		const sessionId = freshSessionId("barrier-instance-replacement");
		const poisoned = getForegroundDeliveryBarrier(sessionId);
		poisoned.suppressPending();
		const fresh = ensureHealthyForegroundDeliveryBarrier(sessionId);
		assert.notEqual(fresh, poisoned);
		assert.equal(poisoned.isSuppressed(), true, "poisoned instance retains its terminal state");
	});

	it("markDelivery is irreversible on a suppressed lifecycle", () => {
		const lifecycle = createLifecycle(Date.now());
		const suppressed = markDelivery(lifecycle, "suppressed");
		assert.equal(shouldDeliverSubagentCompletion({ lifecycle: suppressed }), false);
		assert.equal(shouldDeliverSubagentCompletion({ lifecycle: markDelivery(suppressed, "delivered") }), false);
	});
});
