export interface ForegroundBarrierLease {
	readonly id: string;
	release(): void;
}

interface HeldDelivery {
	sequence: number;
	send: (wake: boolean) => void | Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

const DELIVERY_BARRIER_VERSION = 2;

export class ForegroundDeliveryBarrier {
	/** Read via any-cast on legacy global instances after extension reload (see getForegroundDeliveryBarrier). */
	// fallow-ignore-next-line unused-class-member
	readonly version = DELIVERY_BARRIER_VERSION;
	private readonly foregroundIds = new Set<string>();
	private nextSequence = 0;
	private held: HeldDelivery[] = [];
	private flushing = false;
	private suppressedError: Error | undefined;
	private inFlight: HeldDelivery | undefined;
	private inFlightReject: ((error: Error) => void) | undefined;
	private migrationPending = false;
	private suppressionGeneration = 0;
	private wakeIssued = false;

	enter(id = `foreground-${this.nextSequence++}`): ForegroundBarrierLease {
		if (this.suppressedError) throw this.suppressedError;
		this.foregroundIds.add(id);
		let released = false;
		return {
			id,
			release: () => {
				if (released) return;
				released = true;
				this.foregroundIds.delete(id);
				if (!this.isActive()) void this.flush();
			},
		};
	}

	/** Replace leaked ownership after reload with the exact queued/running foreground set. */
	reconcileActive(activeIds: Iterable<string>): void {
		this.foregroundIds.clear();
		for (const id of activeIds) this.foregroundIds.add(id);
		this.migrationPending = false;
		if (!this.isActive()) void this.flush();
	}
	adoptHeld(deliveries: HeldDelivery[]): void {
		this.held.push(...deliveries);
		this.held.sort((a, b) => a.sequence - b.sequence);
		this.migrationPending = true;
	}

	isActive(): boolean {
		return this.migrationPending || this.foregroundIds.size > 0;
	}

	isSuppressed(): boolean {
		return this.suppressedError !== undefined;
	}

	// fallow-ignore-next-line unused-class-member -- public barrier query API preserved from HEAD
	pendingCount(): number {
		return this.held.length + (this.inFlight ? 1 : 0);
	}

	deliver(send: (wake: boolean) => void | Promise<void>): Promise<void> {
		if (this.suppressedError) return Promise.reject(this.suppressedError);
		return new Promise<void>((resolve, reject) => {
			this.held.push({ sequence: this.nextSequence++, send, resolve, reject });
			this.held.sort((a, b) => a.sequence - b.sequence);
			if (!this.isActive()) void this.flush();
		});
	}

	suppressPending(reason = "Subagent delivery suppressed during shutdown."): void {
		this.suppressedError ??= new Error(reason);
		this.suppressionGeneration++;
		this.inFlightReject?.(this.suppressedError);
		// Keep the in-flight record until its retry loop observes the generation
		// change and exits; this prevents reload/shutdown from losing ownership of
		// a send that is still awaiting API acceptance.
		this.wakeIssued = false;
		for (const pending of this.held.splice(0)) pending.reject(this.suppressedError);
	}

	private async flush(): Promise<void> {
		if (!this.canFlush()) return;
		this.flushing = true;
		const flushGeneration = this.suppressionGeneration;
		try {
			// Let deliveries scheduled in this turn join the initial batch.
			await Promise.resolve();
			await this.drainHeldDeliveries(flushGeneration);
		} finally {
			this.finishFlush();
		}
	}

	private canFlush(): boolean {
		return !this.flushing && !this.isActive() && this.held.length > 0 && !this.suppressedError;
	}

	private async drainHeldDeliveries(flushGeneration: number): Promise<void> {
		const drain = { batch: this.takeHeldBatch(), index: 0 };
		for (;;) {
			const cancellation = this.flushCancellation(flushGeneration);
			if (cancellation) {
				this.rejectRemainingDeliveries(drain, cancellation);
				return;
			}
			const pending = this.nextHeldDelivery(drain);
			if (!pending) return;
			const wake = !this.wakeIssued && drain.index === drain.batch.length && this.held.length === 0;
			await this.deliverHeldEntry(pending, wake, flushGeneration);
		}
	}

	private takeHeldBatch(): HeldDelivery[] {
		return this.held.splice(0).sort((a, b) => a.sequence - b.sequence);
	}

	private flushCancellation(flushGeneration: number): Error | undefined {
		if (!this.isActive() && !this.suppressedError && flushGeneration === this.suppressionGeneration)
			return undefined;
		return this.suppressedError ?? new Error("Foreground delivery resumed while flushing.");
	}

	private rejectRemainingDeliveries(drain: { batch: HeldDelivery[]; index: number }, error: Error): void {
		for (const pending of drain.batch.slice(drain.index)) pending.reject(error);
	}

	private nextHeldDelivery(drain: { batch: HeldDelivery[]; index: number }): HeldDelivery | undefined {
		if (drain.index >= drain.batch.length) this.appendHeldFollowers(drain.batch);
		return drain.index < drain.batch.length ? drain.batch[drain.index++] : undefined;
	}

	private appendHeldFollowers(batch: HeldDelivery[]): void {
		if (this.held.length === 0) return;
		// A follower may have arrived while the previous send was in flight. Keep it
		// in this drain and reserve no second wake after an accepted parent wake.
		batch.push(...this.takeHeldBatch());
	}

	private async deliverHeldEntry(pending: HeldDelivery, wake: boolean, flushGeneration: number): Promise<void> {
		this.inFlight = pending;
		this.inFlightReject = pending.reject;
		try {
			await retryAcceptedDelivery(() => pending.send(wake), {
				shouldContinue: () => this.flushCancellation(flushGeneration) === undefined,
				cancellationError: () => this.flushCancellation(flushGeneration),
			});
			this.settleAcceptedEntry(pending, wake, flushGeneration);
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.inFlight = undefined;
			this.inFlightReject = undefined;
		}
	}

	private settleAcceptedEntry(pending: HeldDelivery, wake: boolean, flushGeneration: number): void {
		if (wake && !this.suppressedError && flushGeneration === this.suppressionGeneration) this.wakeIssued = true;
		if (this.suppressedError || flushGeneration !== this.suppressionGeneration) {
			pending.reject(this.suppressedError ?? new Error("Subagent delivery suppressed."));
			return;
		}
		pending.resolve();
	}

	private finishFlush(): void {
		this.flushing = false;
		if (!this.isActive() && this.held.length > 0 && !this.suppressedError) void this.flush();
		if (this.held.length === 0 && !this.inFlight) this.wakeIssued = false;
	}
}

export async function retryAcceptedDelivery(
	send: () => void | Promise<void>,
	options: {
		attempts?: number;
		delayMs?: number;
		sleep?: (ms: number) => Promise<void>;
		shouldContinue?: () => boolean;
		cancellationError?: () => Error | undefined;
	} = {},
): Promise<void> {
	const attempts = Math.max(1, options.attempts ?? 3);
	const delayMs = Math.max(0, options.delayMs ?? 50);
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (options.shouldContinue && !options.shouldContinue()) {
			throw options.cancellationError?.() ?? new Error("Subagent delivery cancelled.");
		}
		try {
			await send();
			return;
		} catch (error) {
			lastError = error;
			if (attempt < attempts) await sleep(delayMs * attempt);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const DELIVERY_BARRIERS_KEY = Symbol.for("pi-subagent-herdr/delivery-barriers");

function flushLegacyBarrier(barrier: any): HeldDelivery[] {
	try {
		return Array.isArray(barrier.held) ? barrier.held.splice(0) : [];
	} catch {
		return [];
	}
}

export function getForegroundDeliveryBarrier(parentSessionId: string): ForegroundDeliveryBarrier {
	const globals = globalThis as any;
	const barriers: Map<string, ForegroundDeliveryBarrier | any> =
		globals[DELIVERY_BARRIERS_KEY] ??
		(globals[DELIVERY_BARRIERS_KEY] = new Map<string, ForegroundDeliveryBarrier>());
	let barrier = barriers.get(parentSessionId);
	if (!barrier || barrier.version !== DELIVERY_BARRIER_VERSION) {
		const legacyHeld = barrier ? flushLegacyBarrier(barrier) : [];
		const next = new ForegroundDeliveryBarrier();
		if (legacyHeld.length > 0) next.adoptHeld(legacyHeld);
		barrier = next;
		barriers.set(parentSessionId, barrier);
	}
	return barrier;
}
