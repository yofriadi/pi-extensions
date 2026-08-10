export type AdmissionClass = "foreground" | "background";
export type AdmissionState = "queued" | "admitted" | "cancelled" | "released";

export interface AdmissionLease {
	id: string;
	class: AdmissionClass;
	state: AdmissionState;
	queuedAt: number;
	admittedAt?: number;
	release(): void;
	cancel(): boolean;
	isCurrent?(): boolean;
}

interface PendingAdmission {
	lease: AdmissionLeaseImpl;
	resolve: (lease: AdmissionLease) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	generation: number;
}

class AdmissionLeaseImpl implements AdmissionLease {
	state: AdmissionState;
	admittedAt?: number;
	readonly class: AdmissionClass;
	readonly coordinator: AdmissionCoordinator;
	readonly id: string;
	readonly queuedAt: number;
	private settled = false;

	constructor(
		coordinator: AdmissionCoordinator,
		id: string,
		admissionClass: AdmissionClass,
		queuedAt: number,
		state: AdmissionState,
	) {
		this.coordinator = coordinator;
		this.id = id;
		this.queuedAt = queuedAt;
		this.class = admissionClass;
		this.state = state;
		if (state === "admitted") this.admittedAt = Date.now();
	}

	release(): void {
		if (this.settled || this.state !== "admitted") return;
		this.settled = true;
		this.state = "released";
		this.coordinator.release(this);
	}
	isCurrent(): boolean {
		return this.coordinator.isAdmissionCurrent(this);
	}

	cancel(): boolean {
		if (this.settled) return false;
		if (this.state === "queued") return this.coordinator.cancelQueued(this.id, this.class);
		if (this.state === "admitted") return this.coordinator.cancelActive(this);
		return false;
	}

	markAdmitted(): void {
		if (this.settled) return;
		this.state = "admitted";
		this.admittedAt = Date.now();
	}

	markCancelled(): void {
		if (this.settled) return;
		this.settled = true;
		this.state = "cancelled";
	}
}

export interface AdmissionRequest {
	id: string;
	class: AdmissionClass;
	signal?: AbortSignal;
}

export interface AdmissionTicket {
	queued: boolean;
	lease: AdmissionLease;
	admitted: Promise<AdmissionLease>;
}

export class AdmissionCoordinator {
	readonly version = 2;
	readonly limits = { foreground: 1, background: 4 } as const;
	private active = { foreground: 0, background: 0 };
	private activeLeases = new Map<string, AdmissionLeaseImpl>();
	private legacyActiveIds = new Set<string>();
	private queues: Record<AdmissionClass, PendingAdmission[]> = {
		foreground: [],
		background: [],
	};
	private shutdown = false;
	private generation = 0;

	request(request: AdmissionRequest): AdmissionTicket {
		if (this.shutdown) throw new Error("Subagent coordinator is shut down.");
		if (request.signal?.aborted) throw new Error("Subagent admission cancelled.");
		if (this.hasId(request.id)) throw new Error(`Duplicate subagent run ${JSON.stringify(request.id)}.`);

		const canAdmit =
			this.active[request.class] < this.limits[request.class] && this.queues[request.class].length === 0;
		const lease = new AdmissionLeaseImpl(
			this,
			request.id,
			request.class,
			Date.now(),
			canAdmit ? "admitted" : "queued",
		);
		if (canAdmit) {
			this.active[request.class]++;
			this.activeLeases.set(request.id, lease);
			(lease as AdmissionLeaseImpl & { generation?: number }).generation = this.generation;
			return { queued: false, lease, admitted: Promise.resolve(lease) };
		}

		let pending!: PendingAdmission;
		const admitted = new Promise<AdmissionLease>((resolve, reject) => {
			pending = { lease, resolve, reject, signal: request.signal, generation: this.generation };
		});
		if (request.signal) {
			pending.onAbort = () => this.cancelQueued(request.id, request.class);
			request.signal.addEventListener("abort", pending.onAbort, { once: true });
		}
		this.queues[request.class].push(pending);
		return { queued: true, lease, admitted };
	}

	counts(): { foreground: number; background: number; queuedForeground: number; queuedBackground: number } {
		return {
			foreground: this.active.foreground,
			background: this.active.background,
			queuedForeground: this.queues.foreground.length,
			queuedBackground: this.queues.background.length,
		};
	}

	cancelQueued(id: string, admissionClass?: AdmissionClass): boolean {
		for (const kind of admissionClass ? [admissionClass] : (["foreground", "background"] as const)) {
			const index = this.queues[kind].findIndex((entry) => entry.lease.id === id);
			if (index < 0) continue;
			const [pending] = this.queues[kind].splice(index, 1);
			this.detachAbort(pending);
			pending.lease.markCancelled();
			pending.reject(new Error("Subagent admission cancelled."));
			return true;
		}
		return false;
	}

	cancelAllQueued(): void {
		for (const kind of ["foreground", "background"] as const) {
			for (const pending of this.queues[kind].splice(0)) {
				this.detachAbort(pending);
				pending.lease.markCancelled();
				pending.reject(new Error("Subagent admission cancelled."));
			}
		}
	}

	shutdownNow(): void {
		this.shutdown = true;
		this.generation++;
		this.cancelAllQueued();
		for (const lease of Array.from(this.activeLeases.values())) this.cancelActive(lease);
		// v1 coordinators only persisted IDs, not revocable lease objects. Clear
		// those IDs and counters as part of shutdown so every migrated lease fails
		// the coordinator gate even if its old object still says "admitted".
		this.legacyActiveIds.clear();
		this.active.foreground = 0;
		this.active.background = 0;
	}

	cancelActive(lease: AdmissionLeaseImpl): boolean {
		if (this.activeLeases.get(lease.id) !== lease || lease.state !== "admitted") return false;
		this.activeLeases.delete(lease.id);
		this.legacyActiveIds.delete(lease.id);
		lease.markCancelled();
		this.active[lease.class] = Math.max(0, this.active[lease.class] - 1);
		if (!this.shutdown) this.admitNext(lease.class);
		return true;
	}

	release(lease: AdmissionLeaseImpl): void {
		this.activeLeases.delete(lease.id);
		this.legacyActiveIds.delete(lease.id);
		this.active[lease.class] = Math.max(0, this.active[lease.class] - 1);
		if (!this.shutdown) this.admitNext(lease.class);
	}

	private admitNext(kind: AdmissionClass): void {
		while (this.active[kind] < this.limits[kind]) {
			const pending = this.queues[kind].shift();
			if (!pending) return;
			this.detachAbort(pending);
			if (pending.signal?.aborted || pending.lease.state === "cancelled") {
				pending.lease.markCancelled();
				pending.reject(new Error("Subagent admission cancelled."));
				continue;
			}
			this.active[kind]++;
			this.activeLeases.set(pending.lease.id, pending.lease);
			pending.lease.markAdmitted();
			(pending.lease as AdmissionLeaseImpl & { generation?: number }).generation = pending.generation;
			pending.resolve(pending.lease);
		}
	}

	private detachAbort(pending: PendingAdmission): void {
		if (pending.signal && pending.onAbort) {
			pending.signal.removeEventListener("abort", pending.onAbort);
		}
	}

	private hasId(id: string): boolean {
		return (
			this.activeLeases.has(id) ||
			this.legacyActiveIds.has(id) ||
			this.queues.foreground.some((entry) => entry.lease.id === id) ||
			this.queues.background.some((entry) => entry.lease.id === id)
		);
	}
	/**
	 * Validate the coordinator-owned admission, not just the lease object's
	 * state. This remains fail-closed for v1 lease objects retained across a
	 * reload: shutdown clears legacyActiveIds, even though old objects cannot be
	 * actively cancelled in place.
	 */
	isAdmissionCurrent(lease: AdmissionLease): boolean {
		if (this.shutdown || lease.state !== "admitted") return false;
		const current = this.activeLeases.get(lease.id);
		if (current === lease) {
			return (lease as AdmissionLeaseImpl & { generation?: number }).generation === this.generation;
		}
		return this.legacyActiveIds.has(lease.id);
	}
}

const COORDINATORS_KEY = Symbol.for("pi-subagent-herdr/coordinators");

export function getAdmissionCoordinator(parentSessionId: string): AdmissionCoordinator {
	const globals = globalThis as any;
	const coordinators: Map<string, AdmissionCoordinator> =
		globals[COORDINATORS_KEY] ?? (globals[COORDINATORS_KEY] = new Map<string, AdmissionCoordinator>());
	let coordinator = coordinators.get(parentSessionId);
	if (!coordinator) {
		coordinator = new AdmissionCoordinator();
		coordinators.set(parentSessionId, coordinator);
	} else if ((coordinator as any).version !== 2) {
		const legacyIds: Set<string> = new Set(Array.from((coordinator as any).activeIds ?? []));
		const wasShutdown = Boolean((coordinator as any).shutdown);
		Object.setPrototypeOf(coordinator, AdmissionCoordinator.prototype);
		if (!(coordinator as any).active || typeof (coordinator as any).active !== "object") {
			(coordinator as any).active = { foreground: 0, background: 0 };
		}
		if (!(coordinator as any).queues || typeof (coordinator as any).queues !== "object") {
			(coordinator as any).queues = { foreground: [], background: [] };
		}
		(coordinator as any).activeLeases = new Map<string, AdmissionLeaseImpl>();
		(coordinator as any).legacyActiveIds = legacyIds;
		(coordinator as any).generation = wasShutdown ? 1 : 0;
		(coordinator as any).shutdown = wasShutdown;
		// v1 lease objects lack revocation/current-generation semantics. Their
		// IDs remain valid until this coordinator is shut down, then the gate above
		// rejects their launch continuations before any pane/resource creation.
		Object.defineProperty(coordinator, "version", { value: 2, enumerable: true });
	}
	return coordinator;
}
