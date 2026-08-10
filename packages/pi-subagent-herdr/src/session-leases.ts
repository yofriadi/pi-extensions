import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type SessionLeaseState = "queued" | "starting" | "running" | "interrupted" | "finalizing";

export interface SessionLease {
	readonly path: string;
	readonly runId: string;
	state: SessionLeaseState;
	transition(state: SessionLeaseState): void;
	release(): void;
}

class SessionLeaseImpl implements SessionLease {
	private released = false;
	private readonly registry: SessionLeaseRegistry;
	readonly path: string;
	readonly runId: string;
	state: SessionLeaseState;

	constructor(registry: SessionLeaseRegistry, path: string, runId: string, state: SessionLeaseState) {
		this.registry = registry;
		this.path = path;
		this.runId = runId;
		this.state = state;
	}

	transition(state: SessionLeaseState): void {
		if (this.released) throw new Error("Cannot transition a released session lease.");
		this.state = state;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.registry.release(this);
	}
}

export class SessionLeaseRegistry {
	private readonly leases = new Map<string, SessionLeaseImpl>();

	acquire(path: string, runId: string, state: SessionLeaseState = "queued"): SessionLease {
		const canonicalPath = canonicalSessionPath(path);
		const existing = this.leases.get(canonicalPath);
		if (existing) {
			throw new Error(`Subagent session is already ${existing.state}: ${canonicalPath}`);
		}
		const lease = new SessionLeaseImpl(this, canonicalPath, runId, state);
		this.leases.set(canonicalPath, lease);
		return lease;
	}

	get(path: string): SessionLease | undefined {
		return this.leases.get(canonicalSessionPath(path));
	}

	release(lease: SessionLeaseImpl): void {
		if (this.leases.get(lease.path) === lease) this.leases.delete(lease.path);
	}
}

export function canonicalSessionPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

const SESSION_LEASES_KEY = Symbol.for("pi-subagent-herdr/session-leases-v2");

export function getSessionLeaseRegistry(_parentSessionId?: string): SessionLeaseRegistry {
	const globals = globalThis as any;
	return globals[SESSION_LEASES_KEY] ?? (globals[SESSION_LEASES_KEY] = new SessionLeaseRegistry());
}
