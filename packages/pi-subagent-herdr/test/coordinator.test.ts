import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdmissionCoordinator, getAdmissionCoordinator } from "../src/coordinator.ts";

function ticket(
	coordinator: AdmissionCoordinator,
	id: string,
	kind: "foreground" | "background",
	signal?: AbortSignal,
) {
	return coordinator.request({ id, class: kind, signal });
}

describe("AdmissionCoordinator", () => {
	it("admits one foreground and four background independently", () => {
		const c = new AdmissionCoordinator();
		const fg = ticket(c, "fg", "foreground");
		const backgrounds = Array.from({ length: 4 }, (_, i) => ticket(c, `bg-${i}`, "background"));
		assert.equal(fg.queued, false);
		assert.deepEqual(
			backgrounds.map((entry) => entry.queued),
			[false, false, false, false],
		);
		assert.deepEqual(c.counts(), { foreground: 1, background: 4, queuedForeground: 0, queuedBackground: 0 });
	});

	it("serializes foreground FIFO and keeps release idempotent", async () => {
		const c = new AdmissionCoordinator();
		const first = ticket(c, "first", "foreground");
		const second = ticket(c, "second", "foreground");
		const third = ticket(c, "third", "foreground");
		assert.equal(second.queued, true);
		assert.equal(third.queued, true);
		first.lease.release();
		first.lease.release();
		assert.equal((await second.admitted).id, "second");
		second.lease.release();
		assert.equal((await third.admitted).id, "third");
	});

	it("queues fifth and later background in FIFO order", async () => {
		const c = new AdmissionCoordinator();
		const active = Array.from({ length: 4 }, (_, i) => ticket(c, `a-${i}`, "background"));
		const fifth = ticket(c, "fifth", "background");
		const sixth = ticket(c, "sixth", "background");
		active[0].lease.release();
		assert.equal((await fifth.admitted).id, "fifth");
		active[1].lease.release();
		assert.equal((await sixth.admitted).id, "sixth");
	});

	it("cancels queued work including aborted foreground calls without admission", async () => {
		const c = new AdmissionCoordinator();
		const first = ticket(c, "first", "foreground");
		const abort = new AbortController();
		const queued = ticket(c, "queued", "foreground", abort.signal);
		abort.abort();
		await assert.rejects(queued.admitted, /cancelled/);
		first.lease.release();
		assert.equal(c.counts().foreground, 0);
		assert.equal(queued.lease.state, "cancelled");
	});

	it("cancels all queues on shutdown", async () => {
		const c = new AdmissionCoordinator();
		ticket(c, "active", "foreground");
		const queued = ticket(c, "queued", "foreground");
		c.shutdownNow();
		await assert.rejects(queued.admitted, /cancelled/);
		assert.throws(() => ticket(c, "late", "background"), /shut down/);
	});

	it("revokes active admissions on shutdown before a launch callback can start", () => {
		const c = new AdmissionCoordinator();
		const admitted = ticket(c, "admitted-before-shutdown", "background");
		assert.equal(admitted.lease.state, "admitted");
		c.shutdownNow();
		assert.equal(admitted.lease.state, "cancelled");
		assert.equal(c.counts().background, 0);
	});

	it("rejects an ID that is already active", () => {
		const c = new AdmissionCoordinator();
		ticket(c, "active-duplicate", "background");
		assert.throws(() => ticket(c, "active-duplicate", "background"), /Duplicate subagent run/);
	});

	it("handles simultaneous admission races without exceeding either class", async () => {
		const c = new AdmissionCoordinator();
		const requests = await Promise.all(
			Array.from({ length: 12 }, async (_, i) =>
				ticket(c, `race-${i}`, i % 3 === 0 ? "foreground" : "background"),
			),
		);
		const counts = c.counts();
		assert.equal(counts.foreground, 1);
		assert.equal(counts.background, 4);
		assert.equal(counts.queuedForeground, 3);
		assert.equal(counts.queuedBackground, 4);
		for (const request of requests) request.lease.release();
	});

	it("keeps class release independent and admits after terminal releases", async () => {
		for (const terminal of ["success", "failure", "cancel", "disappearance", "rollback", "shutdown"]) {
			const c = new AdmissionCoordinator();
			const fg = ticket(c, `${terminal}-fg`, "foreground");
			const waitingFg = ticket(c, `${terminal}-fg-next`, "foreground");
			const activeBg = Array.from({ length: 4 }, (_, i) => ticket(c, `${terminal}-bg-${i}`, "background"));
			const waitingBg = ticket(c, `${terminal}-bg-next`, "background");
			activeBg[0].lease.release();
			assert.equal((await waitingBg.admitted).id, `${terminal}-bg-next`);
			assert.equal(waitingFg.lease.state, "queued");
			fg.lease.release();
			assert.equal((await waitingFg.admitted).id, `${terminal}-fg-next`);
		}
	});

	it("admits background work after foreground settlement", () => {
		const c = new AdmissionCoordinator();
		const foreground = ticket(c, "foreground-run", "foreground");
		foreground.lease.release();
		const background = ticket(c, "background-run", "background");
		assert.equal(background.queued, false);
		assert.equal(background.lease.class, "background");
	});

	it("invalidates an admitted lease through a shutdown generation", () => {
		const c = new AdmissionCoordinator();
		const active = ticket(c, "legacy-like", "background");
		assert.equal(active.lease.isCurrent?.(), true);
		c.shutdownNow();
		assert.equal(active.lease.state, "cancelled");
		assert.equal(active.lease.isCurrent?.(), false);
	});

	it("reuses one process-global coordinator per parent session", () => {
		assert.equal(getAdmissionCoordinator("parent-a"), getAdmissionCoordinator("parent-a"));
		assert.notEqual(getAdmissionCoordinator("parent-a"), getAdmissionCoordinator("parent-b"));
	});

	it("revokes migrated v1 active IDs through the coordinator launch gate", () => {
		const key = Symbol.for("pi-subagent-herdr/coordinators");
		const globals = globalThis as any;
		const previous = globals[key];
		const parent = `legacy-${Date.now()}-${Math.random()}`;
		const legacy = {
			activeIds: new Set(["legacy-run"]),
			active: { foreground: 0, background: 1 },
			shutdown: false,
		};
		globals[key] = new Map([[parent, legacy]]);
		try {
			const upgraded = getAdmissionCoordinator(parent);
			const legacyLease = {
				id: "legacy-run",
				class: "background" as const,
				state: "admitted" as const,
				queuedAt: Date.now(),
				release() {},
				cancel() {
					return false;
				},
			};
			assert.equal(upgraded.isAdmissionCurrent(legacyLease), true);
			upgraded.shutdownNow();
			assert.equal(legacyLease.state, "admitted");
			assert.equal(upgraded.isAdmissionCurrent(legacyLease), false);
		} finally {
			if (previous === undefined) delete globals[key];
			else globals[key] = previous;
		}
	});
});
