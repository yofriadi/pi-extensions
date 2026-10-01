/**
 * Opt-in integration suite: real in-process MCP round-trips against
 * `tilth --mcp` (the tilth binary on PATH, `npx -y tilth --mcp` fallback).
 * Requires the tilth binary (or network on a cold npx cache) and is never run
 * by `pnpm test` — run explicitly via `pnpm test:integration`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TilthMcpTransport } from "../../src/lib/transport";

let workspace: string;
let transport: TilthMcpTransport;
const durations: Record<string, number> = {};

function resolveMode(): "binary" | "npx" {
	try {
		execFileSync("tilth", ["--version"], { stdio: "ignore" });
		return "binary";
	} catch {
		return "npx";
	}
}

beforeAll(() => {
	workspace = mkdtempSync(join(tmpdir(), "pi-tilth-integration-"));
	writeFileSync(
		join(workspace, "alpha.ts"),
		[
			"export function alpha(): number {",
			"\treturn 1;",
			"}",
			"",
			"export function beta(): number {",
			"\treturn alpha() + 1;",
			"}",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(workspace, "gamma.ts"),
		'import { alpha } from "./alpha";\n\nconst sum = alpha() + alpha();\nexport { sum };\n',
	);
	transport = new TilthMcpTransport({
		mode: resolveMode(),
		config: { callTimeoutMs: 60_000, hashlineCompat: false },
		cwd: workspace,
	});
});

afterAll(async () => {
	await transport.stop();
	rmSync(workspace, { recursive: true, force: true });
});

/** One tool call over the persistent connection, scoped to the workspace root. */
async function call(tool: string, params: Record<string, unknown> = {}): Promise<string> {
	const started = performance.now();
	const text = await transport.callTool(tool, { root: workspace, ...params });
	durations[tool] = (durations[tool] ?? 0) + (performance.now() - started);
	return text;
}

describe("tilth round-trips (native in-process transport)", () => {
	it("tilth_search returns structural results", async () => {
		const out = await call("tilth_search", { query: "alpha" });
		expect(out).toContain("alpha");
	});

	it("tilth_read full view header + content", async () => {
		const out = await call("tilth_read", { path: join(workspace, "alpha.ts") });
		expect(out).toMatch(/^# .*alpha\.ts \(\d+ lines?, ~\d+ tokens\) \[/);
		expect(out).toContain("export function alpha");
	});

	it("tilth_read section view emits line-number gutters", async () => {
		const out = await call("tilth_read", { path: join(workspace, "alpha.ts"), section: "5-7" });
		expect(out).toContain("[section]");
		expect(out).toMatch(/^5 {2}export function beta/m);
	});

	it("tilth_list renders a tree", async () => {
		const out = await call("tilth_list", { patterns: ["*.ts"] });
		expect(out).toContain("alpha.ts");
	});

	it("tilth_deps reports dependents of alpha.ts", async () => {
		const out = await call("tilth_deps", { path: join(workspace, "alpha.ts") });
		expect(out.toLowerCase()).toContain("alpha.ts");
	});

	it("tilth_grok assembles a symbol report", async () => {
		const out = await call("tilth_grok", { target: "alpha" });
		expect(out).toContain("alpha");
	});

	it("tilth_diff summarizes uncommitted changes without crashing", async () => {
		// workspace is not a git repo; the server reports a clean/error state
		// rather than throwing.
		const out = await call("tilth_diff");
		expect(out.length).toBeGreaterThan(0);
	});

	it("tilth_savings accepts the scoped-empty params the command sends", async () => {
		// /tilth-savings forwards applyScoping({}) — a root-only object — to a
		// tool whose schema declares zero properties. The live server must
		// accept the injected root rather than rejecting unknown properties.
		const out = await call("tilth_savings");
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
	});

	it("a repeated identical search elides previously-shown expansion content", async () => {
		// Connection-scoped dedup (the reason for the persistent transport): the
		// second identical query reuses content the server already sent, emitting
		// a `[shown earlier]` marker instead of re-inlining it.
		const first = await call("tilth_search", { query: "sum", expand: 2 });
		expect(first).toContain("sum");
		const second = await call("tilth_search", { query: "sum", expand: 2 });
		expect(second).toContain("[shown earlier]");
	});

	it("records per-tool latency", () => {
		const summary = Object.entries(durations)
			.map(([tool, ms]) => `${tool}: ${(ms / 1000).toFixed(2)}s`)
			.join(", ");
		console.log(`[integration latency] ${summary}`);
		expect(Object.keys(durations).length).toBeGreaterThanOrEqual(7);
	});
});
