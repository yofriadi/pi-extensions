/**
 * Attached stack layout manager.
 *
 * direction:right → first split `right` on caller; subsequent `down` on tallest region pane.
 * direction:down  → first split `down` on caller; subsequent `right` on widest region pane.
 *
 * All splits are herdr's default 50/50 (no --ratio).
 * Selection: geometry via `pane layout` rects (preferred), depth fallback otherwise.
 * Region state lives under Symbol.for("pi-subagent-herdr/layout") for /reload durability.
 */
import {
	createSubagentPane,
	getHerdrPaneLayout,
	type HerdrLayoutPane,
	type HerdrPaneLayout,
	herdrPaneExists,
	splitCurrentPane,
} from "./terminal.ts";

export type LayoutDirection = "right" | "down";
export type LayoutMode = "attached" | "single";
export type SurfaceMode = "pane" | "tab";

export interface RegionPane {
	paneId: string;
	/** Split depth from the region root (0 = first child). Used by depth fallback. */
	depth: number;
	/**
	 * Monotonic insertion order within the region (0 = first child attached).
	 * Never changes on rebalance/reap — used as the final deterministic tie-break
	 * so selection stays stable after mid-stack closes reorder nothing.
	 */
	ord: number;
}

export interface RegionState {
	direction: LayoutDirection;
	/** Parent/caller pane that owns this region (never closed by us). */
	parentPaneId: string;
	panes: RegionPane[];
}

export interface AttachOptions {
	name: string;
	direction?: LayoutDirection;
	/** Working directory for the child pane/tab. */
	cwd?: string;
	/** When set, skip attached logic and create a single split of the caller. */
	layout?: LayoutMode;
	surface?: SurfaceMode;
}

export interface AttachResult {
	paneId: string;
	/** True when we fell back to a tab because the caller was too small. */
	fellBackToTab?: boolean;
	warning?: string;
}

/** Minimum parent terminal size (cols/rows) before attached splits are useful. From spike 0.4. */
export const MIN_ATTACHED_COLS_RIGHT = 100;
export const MIN_ATTACHED_ROWS_DOWN = 24;

const LAYOUT_KEY = Symbol.for("pi-subagent-herdr/layout");

type LayoutStore = {
	regions: Map<string, RegionState>;
	/** Per-parent launch queues for serialization. */
	queues: Map<string, Promise<unknown>>;
};

function getStore(): LayoutStore {
	const g = globalThis as Record<symbol, LayoutStore | undefined>;
	let store = g[LAYOUT_KEY];
	if (!store) {
		store = { regions: new Map(), queues: new Map() };
		g[LAYOUT_KEY] = store;
	}
	return store;
}

/** Test helper: wipe process-global layout state. */
export function resetLayoutStoreForTests(): void {
	const g = globalThis as Record<symbol, LayoutStore | undefined>;
	g[LAYOUT_KEY] = { regions: new Map(), queues: new Map() };
}

export function getRegion(parentPaneId: string): RegionState | undefined {
	return getStore().regions.get(parentPaneId);
}

// fallow-ignore-next-line unused-export -- public region-store query API preserved from HEAD
export function listRegions(): RegionState[] {
	return Array.from(getStore().regions.values());
}

function setRegion(state: RegionState): void {
	getStore().regions.set(state.parentPaneId, state);
}

function deleteRegion(parentPaneId: string): void {
	getStore().regions.delete(parentPaneId);
}

/** Optional last TUI render width (set by the widget) for min-size when stdout is non-TTY. */
const TUI_SIZE_KEY = Symbol.for("pi-subagent-herdr/tui-size");

/** Conservative row estimate when only TUI width is known (widget reports cols only). */
export const DEFAULT_TUI_ROWS_ESTIMATE = 24;

export function rememberTuiSize(size: { columns: number; rows?: number }): void {
	const g = globalThis as Record<symbol, { columns: number; rows?: number } | undefined>;
	const prev = g[TUI_SIZE_KEY];
	g[TUI_SIZE_KEY] = {
		columns: size.columns,
		rows: size.rows ?? prev?.rows ?? DEFAULT_TUI_ROWS_ESTIMATE,
	};
}

function lastTuiSize(): { columns?: number; rows?: number } | undefined {
	return (globalThis as Record<symbol, { columns: number; rows?: number } | undefined>)[TUI_SIZE_KEY];
}

/**
 * Parent terminal dimensions for the min-size guard.
 * Prefer process.stdout when TTY; else last TUI size (widget width + estimated rows).
 * Partial dims are allowed: missing axis is treated as "unknown" by shouldFallBackToTab
 * for the axis that direction does not care about.
 */
export function measureParentTerminal(overrides?: { columns?: number; rows?: number }): {
	columns?: number;
	rows?: number;
} {
	const tui = lastTuiSize();
	const columns =
		overrides?.columns ??
		(typeof process.stdout.columns === "number" && process.stdout.columns > 0
			? process.stdout.columns
			: undefined) ??
		tui?.columns;
	const rows =
		overrides?.rows ??
		(typeof process.stdout.rows === "number" && process.stdout.rows > 0 ? process.stdout.rows : undefined) ??
		tui?.rows;
	return { columns, rows };
}

/**
 * Min-size guard is axis-aware:
 * - direction:right needs columns; missing columns → do not fall back (unknown)
 * - direction:down needs rows; missing rows → do not fall back
 */
export function shouldFallBackToTab(
	direction: LayoutDirection,
	dims: { columns?: number; rows?: number } | null,
): boolean {
	if (!dims) return false;
	if (direction === "right") {
		if (dims.columns == null) return false;
		return dims.columns < MIN_ATTACHED_COLS_RIGHT;
	}
	if (dims.rows == null) return false;
	return dims.rows < MIN_ATTACHED_ROWS_DOWN;
}

/**
 * Pick the region pane to split next.
 * Geometry path: tallest (right-mode) / widest (down-mode), then lowest y, then lowest x, then insertion order.
 * Depth path: shallowest depth, then insertion order.
 */
export function selectRegionPane(region: RegionState, layout: HerdrPaneLayout | null): string {
	if (region.panes.length === 0) {
		throw new Error("selectRegionPane called on empty region");
	}
	if (region.panes.length === 1) return region.panes[0].paneId;

	const regionIds = new Set(region.panes.map((pane) => pane.paneId));
	const geoPanes = layout?.panes.filter((pane) => regionIds.has(pane.paneId)) ?? [];
	return geoPanes.length > 0
		? selectTopPane(geoPanes, geometryPaneComparator(region))
		: selectTopPane(region.panes, fallbackPaneComparator);
}

function selectTopPane<T extends { paneId: string }>(panes: T[], comparator: (left: T, right: T) => number): string {
	return [...panes].sort(comparator)[0].paneId;
}

function geometryPaneComparator(region: RegionState): (left: HerdrLayoutPane, right: HerdrLayoutPane) => number {
	const ords = new Map(region.panes.map((pane) => [pane.paneId, pane.ord]));
	return (left, right) =>
		firstNonZero(
			geometryMetric(region.direction, right) - geometryMetric(region.direction, left),
			left.rect.y - right.rect.y,
			left.rect.x - right.rect.x,
			paneOrdinal(ords, left.paneId) - paneOrdinal(ords, right.paneId),
			comparePaneIds(left.paneId, right.paneId),
		);
}

function geometryMetric(direction: LayoutDirection, pane: HerdrLayoutPane): number {
	return direction === "right" ? pane.rect.height : pane.rect.width;
}

function paneOrdinal(ords: Map<string, number>, paneId: string): number {
	return ords.get(paneId) ?? 0;
}

function fallbackPaneComparator(left: RegionPane, right: RegionPane): number {
	return firstNonZero(left.depth - right.depth, left.ord - right.ord, comparePaneIds(left.paneId, right.paneId));
}

function firstNonZero(...values: number[]): number {
	return values.find((value) => value !== 0) ?? 0;
}

function comparePaneIds(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function firstSplitDirection(direction: LayoutDirection): LayoutDirection {
	return direction; // config direction names the MAIN/children split
}

function subsequentSplitDirection(direction: LayoutDirection): LayoutDirection {
	return direction === "right" ? "down" : "right";
}

/**
 * Re-derive depths from pane layout when available; otherwise decrement the
 * surviving sibling's depth after a removal so depth selection stays roughly balanced.
 */
export function rebalanceDepthsAfterRemoval(
	region: RegionState,
	removedPaneId: string,
	layout: HerdrPaneLayout | null,
): RegionState {
	const remaining = region.panes.filter((p) => p.paneId !== removedPaneId);
	if (remaining.length === 0) {
		return { ...region, panes: [] };
	}

	if (layout) {
		const regionIds = new Set(remaining.map((p) => p.paneId));
		const geo = layout.panes.filter((p) => regionIds.has(p.paneId));
		if (geo.length === remaining.length) {
			const metric = (p: HerdrLayoutPane) => (region.direction === "right" ? p.rect.height : p.rect.width);
			// Rank by size (largest → depth 0). Preserves ord; no log2 drift.
			const ranked = [...geo].sort((a, b) => metric(b) - metric(a) || a.paneId.localeCompare(b.paneId));
			const depthById = new Map(ranked.map((g, i) => [g.paneId, i]));
			const panes = remaining.map((p) => ({
				paneId: p.paneId,
				depth: depthById.get(p.paneId) ?? p.depth,
				ord: p.ord,
			}));
			return { ...region, panes };
		}
	}

	// Depth fallback: decrement survivors that were deeper than the removed pane.
	const removed = region.panes.find((p) => p.paneId === removedPaneId);
	const removedDepth = removed?.depth ?? 0;
	const panes = remaining.map((p) => (p.depth > removedDepth ? { ...p, depth: Math.max(0, p.depth - 1) } : p));
	return { ...region, panes };
}

export function removePaneFromRegion(parentPaneId: string, paneId: string): void {
	const region = getRegion(parentPaneId);
	if (!region) return;
	const layout = getHerdrPaneLayout(parentPaneId);
	const next = rebalanceDepthsAfterRemoval(region, paneId, layout);
	if (next.panes.length === 0) {
		deleteRegion(parentPaneId);
	} else {
		setRegion(next);
	}
}

/**
 * Drop vanished panes (user closed mid-run). Returns removed pane ids.
 */
export function reapVanishedPanes(
	parentPaneId: string,
	paneExists: (id: string) => boolean = herdrPaneExists,
): string[] {
	const region = getRegion(parentPaneId);
	if (!region) return [];
	const removed: string[] = [];
	let current = region;
	for (const pane of region.panes) {
		if (!paneExists(pane.paneId)) {
			removed.push(pane.paneId);
			const layout = getHerdrPaneLayout(parentPaneId);
			current = rebalanceDepthsAfterRemoval(current, pane.paneId, layout);
		}
	}
	if (removed.length === 0) return [];
	if (current.panes.length === 0) deleteRegion(parentPaneId);
	else setRegion(current);
	return removed;
}

/**
 * Serialize a function so concurrent attaches on the same parent never race splits.
 */
export async function withParentLaunchLock<T>(parentPaneId: string, fn: () => Promise<T> | T): Promise<T> {
	const store = getStore();
	const prev = store.queues.get(parentPaneId) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = prev.catch(() => {}).then(() => gate);
	store.queues.set(parentPaneId, tail);
	await prev.catch(() => {});
	try {
		return await fn();
	} finally {
		release();
		if (store.queues.get(parentPaneId) === tail) {
			store.queues.delete(parentPaneId);
		}
	}
}

export type SplitFn = (name: string, direction: LayoutDirection, targetPaneId?: string, cwd?: string) => string;

export type TabCreateFn = (name: string, cwd?: string) => string;

type AttachDependencies = {
	splitFn?: SplitFn;
	tabCreateFn?: TabCreateFn;
	measure?: { columns?: number; rows?: number };
	layoutQuery?: (paneId: string) => HerdrPaneLayout | null;
	paneExists?: (paneId: string) => boolean;
};

type ResolvedAttach = {
	direction: LayoutDirection;
	layoutMode: LayoutMode;
	surface: SurfaceMode;
	splitFn: SplitFn;
	tabCreateFn?: TabCreateFn;
	layoutQuery: (paneId: string) => HerdrPaneLayout | null;
	paneExists?: (paneId: string) => boolean;
	measure?: { columns?: number; rows?: number };
};

/**
 * Create the next attached-region pane for a parent, or fall back to tab/single.
 *
 * `splitFn` / `tabCreateFn` are injectable for unit tests.
 */
export function attachPane(parentPaneId: string, options: AttachOptions, deps?: AttachDependencies): AttachResult {
	const attach = resolveAttach(parentPaneId, options, deps);
	const specialSurface = nonAttachedSurfaceResult(parentPaneId, options, attach);
	if (specialSurface) return specialSurface;
	const initialFallback = initialRegionTabFallback(parentPaneId, options, attach);
	if (initialFallback) return initialFallback;
	reapVanishedPanes(parentPaneId, attach.paneExists);
	const region = getRegion(parentPaneId);
	if (!region || region.panes.length === 0) return createInitialRegion(parentPaneId, options, attach);
	return appendToRegion(parentPaneId, options, attach, region);
}

function resolveAttach(
	_parentPaneId: string,
	options: AttachOptions,
	deps: AttachDependencies | undefined,
): ResolvedAttach {
	return {
		direction: options.direction ?? "right",
		layoutMode: options.layout ?? "attached",
		surface: options.surface ?? "pane",
		splitFn: deps?.splitFn ?? splitCurrentPane,
		tabCreateFn: deps?.tabCreateFn ?? createSubagentPane,
		layoutQuery: deps?.layoutQuery ?? getHerdrPaneLayout,
		paneExists: deps?.paneExists,
		measure: deps?.measure,
	};
}

function nonAttachedSurfaceResult(
	parentPaneId: string,
	options: AttachOptions,
	attach: ResolvedAttach,
): AttachResult | undefined {
	if (attach.surface !== "tab" && attach.layoutMode === "attached") return undefined;
	if (attach.layoutMode === "single" && attach.surface !== "tab") {
		return { paneId: attach.splitFn(options.name, attach.direction, parentPaneId, options.cwd) };
	}
	return directTabResult(options, attach, attach.surface === "tab");
}

function directTabResult(options: AttachOptions, attach: ResolvedAttach, fellBackToTab: boolean): AttachResult {
	if (!attach.tabCreateFn) throw new Error("tab surface requested but no tabCreateFn provided");
	return { paneId: attach.tabCreateFn(options.name, options.cwd), fellBackToTab };
}

function initialRegionTabFallback(
	parentPaneId: string,
	options: AttachOptions,
	attach: ResolvedAttach,
): AttachResult | undefined {
	const existingRegion = getRegion(parentPaneId);
	const isNewRegion = !existingRegion || existingRegion.panes.length === 0;
	if (!isNewRegion || !shouldFallBackToTab(attach.direction, measureParentTerminal(attach.measure))) return undefined;
	if (!attach.tabCreateFn) throw new Error("min-size tab fallback requested but no tabCreateFn provided");
	const threshold =
		attach.direction === "right" ? `${MIN_ATTACHED_COLS_RIGHT} cols` : `${MIN_ATTACHED_ROWS_DOWN} rows`;
	return {
		paneId: attach.tabCreateFn(options.name, options.cwd),
		fellBackToTab: true,
		warning: `Caller terminal too small for attached layout (need ≥ ${threshold}); fell back to tab.`,
	};
}

function createInitialRegion(parentPaneId: string, options: AttachOptions, attach: ResolvedAttach): AttachResult {
	const paneId = attach.splitFn(options.name, firstSplitDirection(attach.direction), parentPaneId, options.cwd);
	setRegion({
		direction: attach.direction,
		parentPaneId,
		panes: [{ paneId, depth: 0, ord: 0 }],
	});
	return { paneId };
}

function appendToRegion(
	parentPaneId: string,
	options: AttachOptions,
	attach: ResolvedAttach,
	region: RegionState,
): AttachResult {
	const conflict = conflictingDirectionTab(options, attach, region);
	if (conflict) return conflict;
	const targetPaneId = selectRegionPane(region, attach.layoutQuery(parentPaneId));
	const paneId = attach.splitFn(options.name, subsequentSplitDirection(region.direction), targetPaneId, options.cwd);
	setRegion(appendRegionPane(region, targetPaneId, paneId));
	return { paneId };
}

function conflictingDirectionTab(
	options: AttachOptions,
	attach: ResolvedAttach,
	region: RegionState,
): AttachResult | undefined {
	if (region.direction === attach.direction) return undefined;
	if (!attach.tabCreateFn) throw new Error("attached layout direction conflict requires an isolated tab");
	return {
		paneId: attach.tabCreateFn(options.name, options.cwd),
		fellBackToTab: true,
		warning: `Attached region uses direction:${region.direction}; isolated direction:${attach.direction} run in a tab.`,
	};
}

function appendRegionPane(region: RegionState, targetPaneId: string, paneId: string): RegionState {
	const target = region.panes.find((pane) => pane.paneId === targetPaneId);
	const depth = (target?.depth ?? 0) + 1;
	const nextOrd = region.panes.reduce((max, pane) => (pane.ord > max ? pane.ord : max), -1) + 1;
	return { ...region, panes: [...region.panes, { paneId, depth, ord: nextOrd }] };
}

/**
 * Async attach with per-parent serialization.
 */
export async function attachPaneSerialized(
	parentPaneId: string,
	options: AttachOptions,
	deps?: Parameters<typeof attachPane>[2],
): Promise<AttachResult> {
	return withParentLaunchLock(parentPaneId, () => attachPane(parentPaneId, options, deps));
}

/**
 * After /reload, try to re-derive a region from pane layout if the store is empty
 * but children still exist. Best-effort; returns null when nothing can be recovered.
 */
export function tryRederiveRegionFromLayout(
	parentPaneId: string,
	direction: LayoutDirection,
	knownChildPaneIds: string[],
	deps?: {
		layoutQuery?: (paneId: string) => HerdrPaneLayout | null;
		paneExists?: (paneId: string) => boolean;
	},
): RegionState | null {
	if (getRegion(parentPaneId)) return getRegion(parentPaneId) ?? null;
	if (knownChildPaneIds.length === 0) return null;
	const layoutQuery = deps?.layoutQuery ?? getHerdrPaneLayout;
	const paneExists = deps?.paneExists ?? herdrPaneExists;
	const layout = layoutQuery(parentPaneId);
	const existing = knownChildPaneIds.filter((id) => paneExists(id));
	if (existing.length === 0) return null;

	let panes: RegionPane[];
	if (layout) {
		const geo = layout.panes.filter((p) => existing.includes(p.paneId));
		const metric = (p: HerdrLayoutPane) => (direction === "right" ? p.rect.height : p.rect.width);
		const ranked = [...geo].sort((a, b) => metric(b) - metric(a) || a.paneId.localeCompare(b.paneId));
		const depthById = new Map(ranked.map((g, i) => [g.paneId, i]));
		panes = existing.map((paneId, index) => ({
			paneId,
			depth: depthById.get(paneId) ?? 0,
			ord: index,
		}));
	} else {
		panes = existing.map((paneId, i) => ({ paneId, depth: i, ord: i }));
	}
	const state: RegionState = { direction, parentPaneId, panes };
	setRegion(state);
	return state;
}
