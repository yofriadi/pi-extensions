export type LaunchStep = "admitted" | "pane" | "script" | "watcher" | "running";

export class LaunchTransaction {
	private readonly rollbacks: Array<() => void> = [];
	private settled = false;
	private readonly controller = new AbortController();
	step: LaunchStep = "admitted";

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	advance(step: LaunchStep): void {
		this.throwIfAborted();
		if (this.settled) throw new Error("Launch transaction is already settled.");
		this.step = step;
	}

	own(rollback: () => void): void {
		if (this.settled) {
			if (this.controller.signal.aborted) {
				try {
					rollback();
				} catch {}
				return;
			}
			throw new Error("Launch transaction is already settled.");
		}
		this.rollbacks.push(rollback);
	}

	throwIfAborted(): void {
		if (this.controller.signal.aborted) throw new Error("Subagent launch cancelled.");
	}

	abort(): void {
		if (this.settled) return;
		this.controller.abort();
		this.rollback();
	}

	commit(): void {
		this.throwIfAborted();
		if (this.settled) throw new Error("Launch transaction is already settled.");
		this.settled = true;
		this.step = "running";
		this.rollbacks.length = 0;
	}

	rollback(): void {
		if (this.settled) return;
		this.settled = true;
		for (const rollback of this.rollbacks.reverse()) {
			try {
				rollback();
			} catch {
				/* preserve the original launch outcome */
			}
		}
		this.rollbacks.length = 0;
	}
}

const LAUNCH_TRANSACTIONS_KEY = Symbol.for("pi-subagent-herdr/launch-transactions");

export function getLaunchTransactions(): Map<string, LaunchTransaction> {
	const globals = globalThis as any;
	return (
		globals[LAUNCH_TRANSACTIONS_KEY] ?? (globals[LAUNCH_TRANSACTIONS_KEY] = new Map<string, LaunchTransaction>())
	);
}

export function beginLaunchTransaction(runId: string): LaunchTransaction {
	const transactions = getLaunchTransactions();
	if (transactions.has(runId)) throw new Error(`Duplicate subagent launch ${JSON.stringify(runId)}.`);
	const transaction = new LaunchTransaction();
	transactions.set(runId, transaction);
	return transaction;
}

export function finishLaunchTransaction(runId: string, transaction: LaunchTransaction): void {
	const transactions = getLaunchTransactions();
	if (transactions.get(runId) === transaction) transactions.delete(runId);
}

export function abortAllLaunchTransactions(): void {
	for (const [runId, transaction] of getLaunchTransactions()) {
		transaction.abort();
		getLaunchTransactions().delete(runId);
	}
}
