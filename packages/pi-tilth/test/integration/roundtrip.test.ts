/**
 * Opt-in integration suite: real `mcporter call` round-trips against
 * `npx tilth --mcp`. Requires network (first run downloads tilth) and is
 * never run by `pnpm test` — run explicitly via `pnpm test:integration`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let workspace: string;
let durations: Record<string, number> = {};

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
	durations = {};
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true });
});

interface Envelope {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

function call(tool: string, params: Record<string, unknown>): Envelope {
	const started = performance.now();
	const stdout = execFileSync(
		"mcporter",
		[
			"call",
			"--stdio",
			"npx",
			"--stdio-arg",
			"-y",
			"--stdio-arg",
			"tilth",
			"--stdio-arg",
			"--mcp",
			"--name",
			"tilth",
			"--tool",
			tool,
			"--output",
			"json",
			"--args",
			JSON.stringify({ root: workspace, ...params }),
			"--yes",
		],
		{ encoding: "utf-8", timeout: 90_000, cwd: tmpdir() },
	);
	durations[tool] = (durations[tool] ?? 0) + (performance.now() - started);
	return JSON.parse(stdout) as Envelope;
}

function text(env: Envelope): string {
	expect(env.isError).toBeFalsy();
	return env.content
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

describe("tilth round-trips (ad-hoc npx transport)", () => {
	it("tilth_search returns structural results", () => {
		const out = text(call("tilth_search", { query: "alpha" }));
		expect(out).toContain("alpha");
	});

	it("tilth_read full view header + content", () => {
		const out = text(call("tilth_read", { path: join(workspace, "alpha.ts") }));
		expect(out).toMatch(/^# .*alpha\.ts \(\d+ lines?, ~\d+ tokens\) \[/);
		expect(out).toContain("export function alpha");
	});

	it("tilth_read section view emits line-number gutters", () => {
		const out = text(
			call("tilth_read", {
				path: join(workspace, "alpha.ts"),
				section: "5-7",
			}),
		);
		expect(out).toContain("[section]");
		expect(out).toMatch(/^5 {2}export function beta/m);
	});

	it("tilth_list renders a tree", () => {
		const out = text(call("tilth_list", { patterns: ["*.ts"] }));
		expect(out).toContain("alpha.ts");
	});

	it("tilth_deps reports dependents of alpha.ts", () => {
		const out = text(call("tilth_deps", { path: join(workspace, "alpha.ts") }));
		expect(out.toLowerCase()).toContain("alpha.ts");
	});

	it("tilth_grok assembles a symbol report", () => {
		const out = text(call("tilth_grok", { target: "alpha" }));
		expect(out).toContain("alpha");
	});

	it("tilth_diff summarizes uncommitted changes without crashing", () => {
		// workspace is not a git repo; the server reports a clean/error state
		// rather than throwing — envelope must parse either way.
		const env = call("tilth_diff", {});
		expect(env.content.length).toBeGreaterThan(0);
	});

	it("tilth_savings accepts the scoped-empty params the command sends", () => {
		// /tilth-savings forwards applyScoping({}) — a root-only object — to a
		// tool whose schema declares zero properties. The live server must
		// accept the injected root rather than rejecting unknown properties.
		const out = text(call("tilth_savings", {}));
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
	});

	it("records per-tool latency", () => {
		const summary = Object.entries(durations)
			.map(([tool, ms]) => `${tool}: ${(ms / 1000).toFixed(2)}s`)
			.join(", ");
		// eslint-disable-next-line no-console
		console.log(`[integration latency] ${summary}`);
		expect(Object.keys(durations).length).toBeGreaterThanOrEqual(7);
	});
});
