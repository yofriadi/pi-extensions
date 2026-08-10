import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	attachPane,
	getRegion,
	MIN_ATTACHED_COLS_RIGHT,
	MIN_ATTACHED_ROWS_DOWN,
	measureParentTerminal,
	type RegionState,
	reapVanishedPanes,
	rebalanceDepthsAfterRemoval,
	rememberTuiSize,
	resetLayoutStoreForTests,
	selectRegionPane,
	shouldFallBackToTab,
	tryRederiveRegionFromLayout,
	withParentLaunchLock,
} from "../src/layout.ts";
import type { HerdrPaneLayout } from "../src/terminal.ts";

beforeEach(() => {
	resetLayoutStoreForTests();
});

describe("layout selection", () => {
	it("picks tallest region pane for direction:right with deterministic tie-break", () => {
		const region: RegionState = {
			direction: "right",
			parentPaneId: "parent",
			panes: [
				{ paneId: "a", depth: 0, ord: 0 },
				{ paneId: "b", depth: 1, ord: 1 },
				{ paneId: "c", depth: 1, ord: 2 },
			],
		};
		const layout: HerdrPaneLayout = {
			panes: [
				{ paneId: "a", rect: { x: 50, y: 0, width: 50, height: 20 } },
				{ paneId: "b", rect: { x: 50, y: 20, width: 50, height: 40 } }, // tallest
				{ paneId: "c", rect: { x: 50, y: 60, width: 50, height: 20 } },
			],
		};
		assert.equal(selectRegionPane(region, layout), "b");

		// tie on height → lowest y, then lowest x
		const tied: HerdrPaneLayout = {
			panes: [
				{ paneId: "a", rect: { x: 60, y: 10, width: 50, height: 30 } },
				{ paneId: "b", rect: { x: 50, y: 10, width: 50, height: 30 } }, // same y, lower x
				{ paneId: "c", rect: { x: 50, y: 40, width: 50, height: 30 } },
			],
		};
		assert.equal(selectRegionPane(region, tied), "b");
	});

	it("falls back to shallowest depth when geometry is unavailable", () => {
		const region: RegionState = {
			direction: "right",
			parentPaneId: "parent",
			panes: [
				{ paneId: "a", depth: 1, ord: 0 },
				{ paneId: "b", depth: 0, ord: 1 },
				{ paneId: "c", depth: 2, ord: 2 },
			],
		};
		assert.equal(selectRegionPane(region, null), "b");
		// ties by insertion order
		const tied: RegionState = {
			direction: "down",
			parentPaneId: "parent",
			panes: [
				{ paneId: "a", depth: 1, ord: 0 },
				{ paneId: "b", depth: 1, ord: 1 },
			],
		};
		assert.equal(selectRegionPane(tied, null), "a");
	});
});

describe("attachPane direction table", () => {
	it("first split targets caller; subsequent use inverse axis on selected child", () => {
		const splits: Array<{ name: string; direction: string; target?: string }> = [];
		const splitFn = (name: string, direction: "right" | "down", targetPaneId?: string) => {
			splits.push({ name, direction, target: targetPaneId });
			return `child-${splits.length}`;
		};

		const exists = () => true;
		const first = attachPane("parent", { name: "A", direction: "right" }, { splitFn, paneExists: exists });
		assert.equal(first.paneId, "child-1");
		assert.deepEqual(splits[0], { name: "A", direction: "right", target: "parent" });
		assert.equal(getRegion("parent")?.panes.length, 1);

		const layoutQuery = () => ({
			panes: [{ paneId: "child-1", rect: { x: 50, y: 0, width: 50, height: 60 } }],
		});
		const second = attachPane(
			"parent",
			{ name: "B", direction: "right" },
			{
				splitFn,
				layoutQuery,
				paneExists: exists,
			},
		);
		assert.equal(second.paneId, "child-2");
		assert.deepEqual(splits[1], { name: "B", direction: "down", target: "child-1" });

		const layoutQuery2 = () => ({
			panes: [
				{ paneId: "child-1", rect: { x: 50, y: 0, width: 50, height: 40 } },
				{ paneId: "child-2", rect: { x: 50, y: 40, width: 50, height: 20 } },
			],
		});
		const third = attachPane(
			"parent",
			{ name: "C", direction: "right" },
			{
				splitFn,
				layoutQuery: layoutQuery2,
				paneExists: exists,
			},
		);
		assert.equal(third.paneId, "child-3");
		assert.deepEqual(splits[2], { name: "C", direction: "down", target: "child-1" });
		assert.equal(getRegion("parent")?.panes.length, 3);
	});

	it("direction:down uses right for subsequent splits on widest", () => {
		const splits: Array<{ direction: string; target?: string }> = [];
		const splitFn = (_n: string, direction: "right" | "down", targetPaneId?: string) => {
			splits.push({ direction, target: targetPaneId });
			return `d-child-${splits.length}`;
		};
		const exists = () => true;
		attachPane("p2", { name: "A", direction: "down" }, { splitFn, paneExists: exists });
		assert.deepEqual(splits[0], { direction: "down", target: "p2" });

		const layoutQuery = () => ({
			panes: [{ paneId: "d-child-1", rect: { x: 0, y: 30, width: 100, height: 30 } }],
		});
		attachPane("p2", { name: "B", direction: "down" }, { splitFn, layoutQuery, paneExists: exists });
		assert.deepEqual(splits[1], { direction: "right", target: "d-child-1" });
	});
});

describe("min-size guard", () => {
	it("falls back to tab when parent terminal is too narrow", () => {
		const tabs: string[] = [];
		const result = attachPane(
			"parent",
			{ name: "Tiny", direction: "right" },
			{
				splitFn: () => {
					throw new Error("should not split");
				},
				tabCreateFn: (name) => {
					tabs.push(name);
					return "tab-pane";
				},
				measure: { columns: MIN_ATTACHED_COLS_RIGHT - 1, rows: 40 },
			},
		);
		assert.equal(result.paneId, "tab-pane");
		assert.equal(result.fellBackToTab, true);
		assert.match(result.warning ?? "", /too small|tab/i);
		assert.deepEqual(tabs, ["Tiny"]);
	});

	it("allows split when dimensions unknown (non-TTY)", () => {
		assert.equal(shouldFallBackToTab("right", null), false);
		assert.equal(shouldFallBackToTab("right", { columns: undefined }), false);
		assert.equal(shouldFallBackToTab("right", { columns: 80 }), true);
		// Axis-aware: right only needs columns; partial measure is fine
		assert.deepEqual(measureParentTerminal({ columns: 120 }), {
			columns: 120,
			rows: undefined,
		});
		assert.deepEqual(measureParentTerminal({ columns: 120, rows: 40 }), {
			columns: 120,
			rows: 40,
		});
		assert.equal(shouldFallBackToTab("down", { columns: 200, rows: MIN_ATTACHED_ROWS_DOWN - 1 }), true);
	});
});

describe("durable ord", () => {
	it("keeps selection stable after rebalance rewrites depths (durable ord)", () => {
		const region: RegionState = {
			direction: "right",
			parentPaneId: "parent",
			panes: [
				{ paneId: "early", depth: 0, ord: 0 },
				{ paneId: "late", depth: 0, ord: 1 },
			],
		};
		const layout: HerdrPaneLayout = {
			panes: [
				{ paneId: "late", rect: { x: 10, y: 10, width: 50, height: 30 } },
				{ paneId: "early", rect: { x: 10, y: 10, width: 50, height: 30 } },
			],
		};
		assert.equal(selectRegionPane(region, layout), "early");

		const after = rebalanceDepthsAfterRemoval(
			{
				...region,
				panes: [
					{ paneId: "early", depth: 0, ord: 0 },
					{ paneId: "mid", depth: 1, ord: 1 },
					{ paneId: "late", depth: 0, ord: 2 },
				],
			},
			"mid",
			null,
		);
		assert.deepEqual(
			after.panes.map((p) => p.ord),
			[0, 2],
		);
		const shuffled: RegionState = {
			direction: "right",
			parentPaneId: "parent",
			panes: [
				{ paneId: "late", depth: 1, ord: 2 },
				{ paneId: "early", depth: 1, ord: 0 },
			],
		};
		assert.equal(selectRegionPane(shuffled, null), "early");
	});
});

describe("reaping and depth", () => {
	it("resets region when empty and rebalances depths after mid-stack close", () => {
		const exists = () => true;
		attachPane("parent", { name: "a" }, { splitFn: () => "a", paneExists: exists });
		attachPane(
			"parent",
			{ name: "b" },
			{
				splitFn: () => "b",
				paneExists: exists,
				layoutQuery: () => ({
					panes: [{ paneId: "a", rect: { x: 0, y: 0, width: 50, height: 60 } }],
				}),
			},
		);
		assert.equal(getRegion("parent")?.panes.length, 2);

		const region: RegionState = {
			direction: "right",
			parentPaneId: "parent",
			panes: [
				{ paneId: "a", depth: 0, ord: 0 },
				{ paneId: "b", depth: 1, ord: 1 },
			],
		};
		const after = rebalanceDepthsAfterRemoval(region, "b", null);
		assert.deepEqual(after.panes, [{ paneId: "a", depth: 0, ord: 0 }]);

		const empty = rebalanceDepthsAfterRemoval(after, "a", null);
		assert.deepEqual(empty.panes, []);
	});
});

describe("serialization", () => {
	it("runs concurrent parent locks sequentially", async () => {
		const order: number[] = [];
		await Promise.all([
			withParentLaunchLock("p", async () => {
				order.push(1);
				await new Promise((r) => setTimeout(r, 30));
				order.push(2);
			}),
			withParentLaunchLock("p", async () => {
				order.push(3);
				order.push(4);
			}),
		]);
		assert.deepEqual(order, [1, 2, 3, 4]);
	});
});

describe("surface options", () => {
	it("surface:tab uses tab path; layout:single splits caller once", () => {
		const tabs: string[] = [];
		const splits: Array<{ target?: string; direction: string }> = [];
		const tab = attachPane(
			"parent",
			{ name: "T", surface: "tab" },
			{
				tabCreateFn: (n) => {
					tabs.push(n);
					return "tab-1";
				},
				splitFn: () => {
					throw new Error("no split");
				},
			},
		);
		assert.equal(tab.paneId, "tab-1");
		assert.deepEqual(tabs, ["T"]);

		const single = attachPane(
			"parent",
			{ name: "S", layout: "single", direction: "down" },
			{
				splitFn: (_n, direction, target) => {
					splits.push({ direction, target });
					return "single-1";
				},
			},
		);
		assert.equal(single.paneId, "single-1");
		assert.deepEqual(splits[0], { direction: "down", target: "parent" });
	});

	it("forwards the child cwd to pane and tab creation", () => {
		const seen: Array<{ kind: string; cwd?: string }> = [];
		attachPane(
			"cwd-parent",
			{ name: "cwd-tab", surface: "tab", cwd: "/tmp/child-cwd" },
			{
				tabCreateFn: (_name, cwd) => {
					seen.push({ kind: "tab", cwd });
					return "cwd-tab";
				},
			},
		);
		attachPane(
			"cwd-parent-single",
			{ name: "cwd-split", layout: "single", cwd: "/tmp/child-cwd" },
			{
				splitFn: (_name, _direction, _target, cwd) => {
					seen.push({ kind: "split", cwd });
					return "cwd-split";
				},
			},
		);
		assert.deepEqual(seen, [
			{ kind: "tab", cwd: "/tmp/child-cwd" },
			{ kind: "split", cwd: "/tmp/child-cwd" },
		]);
	});

	it("isolates a conflicting attached direction in a tab", () => {
		attachPane(
			"conflict-parent",
			{ name: "right", direction: "right" },
			{
				splitFn: () => "right-child",
				paneExists: () => true,
			},
		);
		const result = attachPane(
			"conflict-parent",
			{ name: "down", direction: "down" },
			{
				splitFn: () => {
					throw new Error("conflicting run must not split the attached region");
				},
				tabCreateFn: () => "conflict-tab",
				paneExists: () => true,
			},
		);
		assert.equal(result.paneId, "conflict-tab");
		assert.equal(result.fellBackToTab, true);
		assert.match(result.warning ?? "", /direction:right.*direction:down/);
	});
});

describe("rederive and vanished panes", () => {
	it("reapVanishedPanes drops missing ids and clears empty regions", () => {
		const existsLive = (id: string) => id !== "gone";
		attachPane(
			"parent",
			{ name: "a" },
			{
				splitFn: () => "alive",
				paneExists: () => true,
			},
		);
		attachPane(
			"parent",
			{ name: "b" },
			{
				splitFn: () => "gone",
				paneExists: () => true,
				layoutQuery: () => ({
					panes: [{ paneId: "alive", rect: { x: 0, y: 0, width: 50, height: 60 } }],
				}),
			},
		);
		assert.equal(getRegion("parent")?.panes.length, 2);
		const removed = reapVanishedPanes("parent", existsLive);
		assert.deepEqual(removed, ["gone"]);
		assert.deepEqual(
			getRegion("parent")?.panes.map((p) => p.paneId),
			["alive"],
		);
	});

	it("tryRederiveRegionFromLayout always assigns ord (injectable deps)", () => {
		resetLayoutStoreForTests();
		const state = tryRederiveRegionFromLayout("parent", "right", ["c", "a", "b"], {
			paneExists: (id) => id !== "missing",
			layoutQuery: () => ({
				panes: [
					{ paneId: "a", rect: { x: 0, y: 0, width: 50, height: 30 } },
					{ paneId: "b", rect: { x: 0, y: 30, width: 50, height: 50 } },
					{ paneId: "c", rect: { x: 0, y: 80, width: 50, height: 10 } },
				],
			}),
		});
		assert.ok(state);
		assert.deepEqual(
			state!.panes.map((p) => ({ paneId: p.paneId, depth: p.depth, ord: p.ord })),
			[
				{ paneId: "c", depth: 2, ord: 0 },
				{ paneId: "a", depth: 1, ord: 1 },
				{ paneId: "b", depth: 0, ord: 2 },
			],
		);
		resetLayoutStoreForTests();
		const partial = tryRederiveRegionFromLayout("parent2", "right", ["x", "y"], {
			paneExists: () => true,
			layoutQuery: () => ({
				panes: [{ paneId: "x", rect: { x: 0, y: 0, width: 50, height: 40 } }],
			}),
		});
		assert.deepEqual(
			partial!.panes.map((p) => ({ paneId: p.paneId, ord: p.ord, depth: p.depth })),
			[
				{ paneId: "x", ord: 0, depth: 0 },
				{ paneId: "y", ord: 1, depth: 0 },
			],
		);
	});
});

describe("TUI size fallback", () => {
	it("rememberTuiSize supplies columns and default rows for axis-aware guard", () => {
		rememberTuiSize({ columns: 80 }); // rows defaulted internally
		assert.equal(shouldFallBackToTab("right", { columns: 80 }), true);
		assert.equal(shouldFallBackToTab("right", { columns: 120 }), false);
		// columns-only: right can decide; down needs rows
		assert.equal(shouldFallBackToTab("down", { columns: 200 }), false);
		assert.equal(shouldFallBackToTab("down", { rows: 10 }), true);
	});
});
