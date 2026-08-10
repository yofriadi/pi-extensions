import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getSessionLeaseRegistry, SessionLeaseRegistry } from "../src/session-leases.ts";

describe("session leases", () => {
	it("rejects duplicate aliases across all active lifecycle states", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-lease-"));
		const session = join(dir, "child.jsonl");
		const alias = join(dir, "alias.jsonl");
		writeFileSync(session, "{}\n");
		symlinkSync(session, alias);
		const registry = new SessionLeaseRegistry();
		const lease = registry.acquire(alias, "run-1", "queued");
		assert.equal(lease.path, realpathSync(session));
		for (const state of ["starting", "running", "interrupted", "finalizing"] as const) {
			lease.transition(state);
			assert.throws(() => registry.acquire(session, "run-2"), new RegExp(`already ${state}`));
		}
		lease.release();
		lease.release();
		assert.doesNotThrow(() => registry.acquire(session, "run-2"));
	});

	it("uses one process-global registry across parent sessions", () => {
		const first = getSessionLeaseRegistry("lease-parent");
		const other = getSessionLeaseRegistry("other-parent");
		assert.equal(first, other);
	});
});
