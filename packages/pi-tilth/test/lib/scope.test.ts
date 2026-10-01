import { describe, expect, it } from "vitest";
import { applyScoping, readTargetPaths } from "../../src/lib/scope";

describe("scope — root injection and path absolutization", () => {
	it("injects an absolute root from cwd when absent", () => {
		const scoped = applyScoping({ query: "x" }, "/work/repo");
		expect(scoped.root).toBe("/work/repo");
		expect(scoped.query).toBe("x");
	});

	it("resolves a relative root against the session cwd", () => {
		const scoped = applyScoping({ root: "sub", query: "x" }, "/work/repo");
		expect(scoped.root).toBe("/work/repo/sub");
	});

	it("passes an absolute caller-supplied root through unchanged", () => {
		const scoped = applyScoping({ root: "/other/repo" }, "/work/repo");
		expect(scoped.root).toBe("/other/repo");
	});

	it("absolutizes relative path/paths/scope/context against cwd", () => {
		const scoped = applyScoping(
			{ path: "src/a.ts", paths: ["b.ts", "/abs/c.ts"], scope: "src", context: "src/d.ts" },
			"/work/repo",
		);
		expect(scoped.path).toBe("/work/repo/src/a.ts");
		expect(scoped.paths).toEqual(["/work/repo/b.ts", "/abs/c.ts"]);
		expect(scoped.scope).toBe("/work/repo/src");
		expect(scoped.context).toBe("/work/repo/src/d.ts");
	});

	it("passes an absolute context through unchanged", () => {
		const scoped = applyScoping({ context: "/abs/e.ts" }, "/work/repo");
		expect(scoped.context).toBe("/abs/e.ts");
	});

	it("never touches git refs (a/b/log)", () => {
		const scoped = applyScoping({ a: "HEAD~1", b: "main", log: "HEAD~5..HEAD" }, "/work/repo");
		expect(scoped.a).toBe("HEAD~1");
		expect(scoped.b).toBe("main");
		expect(scoped.log).toBe("HEAD~5..HEAD");
	});

	it("collects de-duplicated read targets", () => {
		expect(
			readTargetPaths({
				path: "/a.ts",
				paths: ["/a.ts", "/b.ts", "", 42],
			}),
		).toEqual(["/a.ts", "/b.ts"]);
	});

	it("injects no scope by default (tilth_read / tilth_diff / tilth_savings)", () => {
		const scoped = applyScoping({ query: "x" }, "/work/repo");
		expect("scope" in scoped).toBe(false);
	});

	it("injects scope = resolved root when defaultScope and the caller omitted scope", () => {
		const scoped = applyScoping({ query: "x" }, "/work/repo", { defaultScope: true });
		expect(scoped.scope).toBe("/work/repo");
		expect(scoped.root).toBe("/work/repo");
	});

	it("injects scope = caller-supplied root for cross-repo queries (defaultScope)", () => {
		const scoped = applyScoping({ root: "/other/repo", query: "x" }, "/work/repo", { defaultScope: true });
		expect(scoped.scope).toBe("/other/repo");
	});

	it("resolves a relative caller root, then anchors the default scope to it", () => {
		const scoped = applyScoping({ root: "sub", query: "x" }, "/work/repo", { defaultScope: true });
		expect(scoped.root).toBe("/work/repo/sub");
		expect(scoped.scope).toBe("/work/repo/sub");
	});

	it("never overrides an explicitly supplied scope", () => {
		const scoped = applyScoping({ scope: "src", query: "x" }, "/work/repo", { defaultScope: true });
		expect(scoped.scope).toBe("/work/repo/src");
	});
});
