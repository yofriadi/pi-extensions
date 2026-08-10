export type SettlementSource = "sidecar" | "sentinel" | "pane-disappearance" | "abort" | "timeout";

export interface SettlementClaim {
	runId: string;
	source: SettlementSource;
	claimedAt: number;
}

export class SettlementRegistry {
	private readonly claims = new Map<string, SettlementClaim>();

	claim(runId: string, source: SettlementSource, claimedAt = Date.now()): SettlementClaim | null {
		if (this.claims.has(runId)) return null;
		const claim = { runId, source, claimedAt };
		this.claims.set(runId, claim);
		return claim;
	}

	get(runId: string): SettlementClaim | undefined {
		return this.claims.get(runId);
	}

	clear(runId: string): void {
		this.claims.delete(runId);
	}
}

const SETTLEMENT_REGISTRIES_KEY = Symbol.for("pi-subagent-herdr/settlement-registries");

export function getSettlementRegistry(parentSessionId: string): SettlementRegistry {
	const globals = globalThis as any;
	const registries: Map<string, SettlementRegistry> =
		globals[SETTLEMENT_REGISTRIES_KEY] ??
		(globals[SETTLEMENT_REGISTRIES_KEY] = new Map<string, SettlementRegistry>());
	let registry = registries.get(parentSessionId);
	if (!registry) {
		registry = new SettlementRegistry();
		registries.set(parentSessionId, registry);
	}
	return registry;
}
