import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const resolveSettlementDisposition: (
	result: { reason: string; exitCode?: number; runId?: string },
	runningId?: string,
) => {
	watchAbandoned: boolean;
	preservePane: boolean;
	preserveArtifacts: boolean;
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
	const artifactDir = join(dir, id);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, "launch.sh"), "#!/bin/bash\n");
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
			assert.equal(
				existsSync(join(dir, "abandon-1")),
				true,
				"an abandoned watch must preserve the companion directory for inspection",
			);
			assert.equal(existsSync(join(dir, "abandon-1", "launch.sh")), true);
		} finally {
			cleanup(running, sessionFile);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the session path exclusive while a live child may still write", async () => {
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
		// An abandoned watch preserves the pane and must free admission while
		// keeping the session lease: the child may still be alive and writing.
		const abandoned = resolveSettlementDisposition({ reason: "timeout", exitCode: 1 });
		assert.equal(abandoned.preservePane, true, "timeout preserves the pane");
		assert.equal(abandoned.releaseAdmissionNow, true, "timeout frees admission at once");
		assert.equal(abandoned.preserveArtifacts, true, "timeout preserves <stem/> for inspection");
		// The session lease is deliberately not part of it: releasing it inline
		// is what made the subsequent transition throw (the Critical bug), so the
		// disposition exposes only the admission decision — session release lives in
		// the pane monitor at explicit disappearance.

		// A settled child error no longer preserves: it reaps the pane through the
		// same single site as a success, so the session file becomes immediately
		// resumable. The preserved catch paths (relaunch-mechanics failures,
		// watcher-threw with unknown child state, watch abandonment) keep their
		// preserve-then-release-admission-only policy above.
		const errored = resolveSettlementDisposition({ reason: "error", exitCode: 1 });
		assert.equal(errored.preservePane, false, "a settled error reaps the pane");
		assert.equal(errored.releaseAdmissionNow, false, "release runs via the ordinary close/reap ownership path");
		assert.equal(errored.preserveArtifacts, true, "a settled error preserves <stem/> for diagnosis");
	});
});

describe("resolveSettlementDisposition — admission vs session", () => {
	it("frees admission immediately for abandoned watches; reaps settled errors through the success path", () => {
		// An abandoned watch keeps its pane (outcome unknown), so its slot must not
		// wait for the user to close that pane. A settled error closes its pane at
		// settlement, so its capacity and session lease release through the same
		// ownership path a success uses.
		assert.equal(resolveSettlementDisposition({ reason: "timeout", exitCode: 1 }).releaseAdmissionNow, true);
		assert.equal(resolveSettlementDisposition({ reason: "error", exitCode: 1 }).releaseAdmissionNow, false);
	});

	it("preserves the abandoned-watch pane and reaps the settled-error pane", () => {
		assert.equal(resolveSettlementDisposition({ reason: "timeout", exitCode: 1 }).preservePane, true);
		assert.equal(resolveSettlementDisposition({ reason: "error", exitCode: 1 }).preservePane, false);
	});
	it("marks only the timeout as an abandoned watch", () => {
		assert.equal(resolveSettlementDisposition({ reason: "timeout", exitCode: 1 }).watchAbandoned, true);
		assert.equal(resolveSettlementDisposition({ reason: "error", exitCode: 1 }).watchAbandoned, false);
	});

	const success: Array<[string, { reason: string; exitCode: number; runId?: string }]> = [
		["owned sidecar", { reason: "done", exitCode: 0, runId: "run-1" }],
		["sentinel", { reason: "sentinel", exitCode: 0 }],
	];
	for (const [label, result] of success) {
		it(`leaves a ${label} success on the normal close/reap path and deletes artifacts`, () => {
			const d = resolveSettlementDisposition(result, "run-1");
			assert.equal(d.preservePane, false);
			assert.equal(d.releaseAdmissionNow, false);
			assert.equal(d.watchAbandoned, false);
			assert.equal(d.preserveArtifacts, false, "a success deletes <stem>/");
		});
	}

	it("preserves artifacts for a nonzero sentinel exit", () => {
		const d = resolveSettlementDisposition({ reason: "sentinel", exitCode: 9 });
		assert.equal(d.preserveArtifacts, true, "a reason-keyed rule would delete a failed run's artifacts");
	});

	it("preserves artifacts for a sidecar success lacking the run's id (fail-closed)", () => {
		const d = resolveSettlementDisposition({ reason: "done", exitCode: 0 }, "run-1");
		assert.equal(d.preserveArtifacts, true, "absent runId must preserve");
	});
});
