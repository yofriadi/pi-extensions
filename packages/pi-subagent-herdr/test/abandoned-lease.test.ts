import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";
import { createLifecycle } from "../src/lifecycle.ts";
import { getSessionLeaseRegistry } from "../src/session-leases.ts";

const testApi = (subagentsModule as any).__test__;
const watchSubagent: (
	running: any,
	signal: AbortSignal,
	options?: { releaseOwnership?: boolean; timeoutMs?: number },
) => Promise<any> = testApi.watchSubagent;
const resolveSettlementDisposition: (reason: string) => {
	watchAbandoned: boolean;
	preservePane: boolean;
	releaseAdmissionNow: boolean;
} = testApi.resolveSettlementDisposition;
const runningSubagents: Map<string, any> = testApi.runningSubagents;

/** Minimal admission lease double: only release()/state are exercised here. */
function fakeAdmissionLease() {
	return {
		id: "adm",
		class: "background" as const,
		state: "admitted" as string,
		queuedAt: Date.now(),
		releases: 0,
		release() {
			this.releases += 1;
			this.state = "released";
		},
		cancel() {
			return false;
		},
	};
}

function makeRun(dir: string, id: string, timeoutMs: number) {
	const sessionFile = join(dir, `${id}.jsonl`);
	writeFileSync(sessionFile, "");
	const sessionLease = getSessionLeaseRegistry().acquire(sessionFile, id, "running");
	const admissionLease = fakeAdmissionLease();
	const running: any = {
		id,
		name: "reviewer",
		task: "review",
		surface: `pane-${id}`,
		startTime: Date.now(),
		sessionFile,
		lifecycle: createLifecycle(Date.now()),
		runtimePlan: undefined,
		sessionLease,
		admissionLease,
		completionTimeoutMs: timeoutMs,
		entryCountBefore: 0,
		parentSessionId: `parent-${id}`,
		// Keep the pane present so the watch runs to its deadline instead of
		// settling early on a fake pane id reporting `missing` via real herdr.
		inspectPaneOverride: async () => ({ kind: "present", observedAt: Date.now(), agentStatus: "working" }),
	};
	return { running, sessionLease, admissionLease, sessionFile };
}

function cleanup(running: any, sessionFile: string) {
	running.sessionLease?.release();
	runningSubagents.delete(running.id);
	try {
		getSessionLeaseRegistry().get(sessionFile)?.release();
	} catch {
		/* already gone */
	}
}

describe("abandoned watch — lease disposition", () => {
	it("releases admission capacity but keeps the session lease usable", async () => {
		// The regression this pins: releasing the session lease at timeout made the
		// very next step (`sessionLease.transition("finalizing")`) throw, so the
		// timeout result was never delivered at all — a capacity fix that silently
		// destroyed delivery. The child may also still be alive and writing to that
		// session, so exclusivity must survive until the pane is really gone.
		const dir = mkdtempSync(join(tmpdir(), "abandon-lease-"));
		const { running, sessionLease, admissionLease, sessionFile } = makeRun(dir, "abandon-1", 40);
		try {
			const controller = new AbortController();
			const result = await watchSubagent(running, controller.signal, { releaseOwnership: false });
			assert.equal(result.watchAbandoned, true, "the run settled as an abandoned watch");
			assert.ok(admissionLease.releases > 0, "admission capacity must be freed immediately");
			assert.doesNotThrow(
				() => sessionLease.transition("finalizing"),
				"the session lease must still be usable — delivery transitions it next",
			);
		} finally {
			cleanup(running, sessionFile);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the session path exclusive so a live child cannot be resumed concurrently", async () => {
		const dir = mkdtempSync(join(tmpdir(), "abandon-exclusive-"));
		const { running, sessionFile } = makeRun(dir, "abandon-2", 40);
		try {
			const controller = new AbortController();
			await watchSubagent(running, controller.signal, { releaseOwnership: false });
			assert.throws(
				() => getSessionLeaseRegistry().acquire(sessionFile, "someone-else", "starting"),
				/already/,
				"an abandoned run's session must not be re-acquirable while its pane may be live",
			);
		} finally {
			cleanup(running, sessionFile);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("preserve-then-release-admission policy is applied", () => {
	// The unexpected-watcher catch paths (watchSubagent and the background
	// supervisor) preserve the pane and must free admission while keeping the
	// session lease. That path only executes when the pane is genuinely preserved,
	// which needs a live herdr pane — a fake probe is either swallowed (advisory)
	// or reports missing (no preserve). So it cannot be exercised in a unit test
	// without real herdr. What CAN be pinned is the policy the catch applies: any
	// preserved pane frees admission immediately while retaining session exclusivity.
	it("preserved outcomes free admission but never the session lease", () => {
		// Structured error and abandoned watch both preserve the pane; both must free
		// admission. The session lease is released only by the pane monitor at
		// explicit disappearance (releaseRunOwnership), never here.
		for (const reason of ["timeout", "error"]) {
			const d = resolveSettlementDisposition(reason);
			assert.equal(d.preservePane, true, `${reason} preserves the pane`);
			assert.equal(d.releaseAdmissionNow, true, `${reason} frees admission at once`);
		}
		// The session lease is deliberately not part of either: releasing it inline
		// is what made the subsequent transition throw (the Critical bug), so the
		// disposition exposes only the admission decision — session release lives in
		// the pane monitor at explicit disappearance.
	});
});

describe("resolveSettlementDisposition — admission vs session", () => {
	it("frees admission for both abandoned watches and reported errors", () => {
		// Both keep a pane for inspection, so neither may hold a slot until the user
		// happens to close that pane: four such runs would block all later work.
		assert.equal(resolveSettlementDisposition("timeout").releaseAdmissionNow, true);
		assert.equal(resolveSettlementDisposition("error").releaseAdmissionNow, true);
	});

	it("still preserves the pane for both", () => {
		assert.equal(resolveSettlementDisposition("timeout").preservePane, true);
		assert.equal(resolveSettlementDisposition("error").preservePane, true);
	});

	it("marks only the timeout as an abandoned watch", () => {
		assert.equal(resolveSettlementDisposition("timeout").watchAbandoned, true);
		assert.equal(resolveSettlementDisposition("error").watchAbandoned, false);
	});

	for (const reason of ["done", "ping", "sentinel"]) {
		it(`leaves a ${reason} completion on the normal close/reap path`, () => {
			const d = resolveSettlementDisposition(reason);
			assert.equal(d.preservePane, false);
			assert.equal(d.releaseAdmissionNow, false);
			assert.equal(d.watchAbandoned, false);
		});
	}
});
