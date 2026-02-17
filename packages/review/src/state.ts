import type { ReviewFinding, ReviewSessionState } from "./types.js";

const STATE_TTL_MS = 1000 * 60 * 60;
const STATE_MAX_ENTRIES = 200;

export class ReviewStateStore {
	private readonly states = new Map<string, ReviewSessionState>();

	constructor(
		private readonly ttlMs = STATE_TTL_MS,
		private readonly maxEntries = STATE_MAX_ENTRIES,
		private readonly now: () => number = () => Date.now(),
	) {}

	get(sessionId: string): ReviewSessionState {
		this.prune();
		const existing = this.states.get(sessionId);
		if (existing) {
			existing.updatedAt = this.now();
			return existing;
		}

		const state: ReviewSessionState = {
			findings: [],
			updatedAt: this.now(),
		};
		this.states.set(sessionId, state);
		this.prune();
		return state;
	}

	reset(sessionId: string, mode?: string): void {
		this.states.set(sessionId, {
			findings: [],
			mode,
			updatedAt: this.now(),
		});
		this.prune();
	}

	touch(sessionId: string): void {
		const state = this.states.get(sessionId);
		if (state) {
			state.updatedAt = this.now();
		}
	}

	has(sessionId: string): boolean {
		this.prune();
		return this.states.has(sessionId);
	}

	size(): number {
		this.prune();
		return this.states.size;
	}

	private prune(): void {
		const now = this.now();
		for (const [sessionId, state] of this.states) {
			if (now - state.updatedAt > this.ttlMs) {
				this.states.delete(sessionId);
			}
		}

		if (this.states.size <= this.maxEntries) {
			return;
		}

		const ordered = [...this.states.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
		const overflow = this.states.size - this.maxEntries;
		for (let i = 0; i < overflow; i++) {
			const key = ordered[i]?.[0];
			if (key) {
				this.states.delete(key);
			}
		}
	}
}

function findingKey(finding: ReviewFinding): string {
	return [
		finding.priority,
		finding.file_path,
		finding.line_start,
		finding.line_end,
		finding.title.toLowerCase(),
		finding.body.toLowerCase(),
	].join("|");
}

export function upsertFinding(findings: ReviewFinding[], finding: ReviewFinding): boolean {
	const key = findingKey(finding);
	const index = findings.findIndex((item) => findingKey(item) === key);
	if (index >= 0) {
		findings[index] = finding;
		return true;
	}
	findings.push(finding);
	return false;
}

export const reviewStateStore = new ReviewStateStore();
