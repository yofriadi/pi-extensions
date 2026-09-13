import { describe, expect, it } from "vitest";
import { createAvailabilityState } from "../../src/lib/availability";
import { loadConfig, normalizeConfig } from "../../src/lib/config";
import type { Exec } from "../../src/lib/exec";
import { buildCallArgs } from "../../src/lib/mcporter";
import { parseEnvelope, ServerToolError, TransportError } from "../../src/lib/result";
import { applyScoping, readTargetPaths } from "../../src/lib/scope";

describe("mcporter — pinned argv (config mode)", () => {
	it("builds the exact spec contract argv", () => {
		expect(
			buildCallArgs({
				mode: "config",
				serverName: "tilth",
				toolName: "tilth_search",
				paramsJson: '{"query":"x"}',
			}),
		).toEqual(["call", "tilth.tilth_search", "--output", "json", "--args", '{"query":"x"}']);
	});
});

describe("mcporter — pinned argv (ad-hoc mode)", () => {
	it("repeats the descriptor and appends --yes", () => {
		expect(
			buildCallArgs({
				mode: "binary",
				serverName: "tilth",
				toolName: "tilth_read",
				paramsJson: '{"path":"/x"}',
			}),
		).toEqual([
			"call",
			"--stdio",
			"tilth",
			"--stdio-arg",
			"--mcp",
			"--name",
			"tilth",
			"--tool",
			"tilth_read",
			"--output",
			"json",
			"--args",
			'{"path":"/x"}',
			"--yes",
		]);
	});

	it("npx mode expands -y tilth --mcp into stdio args", () => {
		const args = buildCallArgs({
			mode: "npx",
			serverName: "tilth",
			toolName: "tilth_list",
			paramsJson: "{}",
		});
		expect(args).toEqual([
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
			"tilth_list",
			"--output",
			"json",
			"--args",
			"{}",
			"--yes",
		]);
	});
});

describe("result — envelope parsing", () => {
	it("joins text content blocks", () => {
		const env = parseEnvelope({
			stdout: JSON.stringify({
				content: [
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
			}),
			stderr: "",
			code: 0,
			killed: false,
		});
		expect(env.text).toBe("one\ntwo");
		expect(env.isError).toBe(false);
	});

	it("maps isError envelopes to ServerToolError with the server's own text", () => {
		expect(() =>
			parseEnvelope({
				stdout: JSON.stringify({
					content: [{ type: "text", text: "boom" }],
					isError: true,
				}),
				stderr: "",
				code: 0,
				killed: false,
			}),
		).toThrowError(ServerToolError);
		try {
			parseEnvelope({
				stdout: JSON.stringify({
					content: [{ type: "text", text: "boom" }],
					isError: true,
				}),
				stderr: "",
				code: 0,
				killed: false,
			});
		} catch (err) {
			expect((err as ServerToolError).message).toBe("boom");
		}
	});

	it("surfaces non-zero exits with stderr verbatim", () => {
		try {
			parseEnvelope({ stdout: "", stderr: "tilth not found", code: 1, killed: false });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(TransportError);
			expect((err as TransportError).message).toContain("tilth not found");
		}
	});

	it("rejects non-JSON stdout with stderr verbatim", () => {
		try {
			parseEnvelope({
				stdout: "hello there",
				stderr: "hint text",
				code: 0,
				killed: false,
			});
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(TransportError);
			expect((err as TransportError).message).toContain("hint text");
		}
		expect(() =>
			parseEnvelope({
				stdout: JSON.stringify({ content: [{ type: "image" }] }),
				stderr: "",
				code: 0,
				killed: false,
			}),
		).toThrowError(TransportError);
	});

	it("treats a killed process as a transport failure even with a complete JSON envelope", () => {
		// pi's exec resolves `code ?? 0` for signal-deaths, so a timeout can
		// yield code 0 + valid-looking stdout. Killed must dominate success.
		expect(() =>
			parseEnvelope({
				stdout: JSON.stringify({ content: [{ type: "text", text: "late result" }] }),
				stderr: "",
				code: 0,
				killed: true,
			}),
		).toThrowError(TransportError);
		try {
			parseEnvelope({ stdout: "", stderr: "worker hung", code: 0, killed: true });
		} catch (err) {
			expect((err as TransportError).message).toContain("worker hung");
			expect((err as TransportError).message).toContain("terminated");
		}
	});
});

const fakeExec = (
	behavior: (cmd: string, args: string[]) => { stdout: string; stderr: string; code: number; killed: boolean },
): Exec => {
	return async (cmd, args) => behavior(cmd, args);
};

describe("availability — probe order", () => {
	it("resolves to config when the configured server exists", async () => {
		const state = createAvailabilityState();
		const exec = fakeExec((cmd, args) => {
			if (cmd === "mcporter" && args[0] === "list") return { stdout: "{}", stderr: "", code: 0, killed: false };
			throw new Error("unexpected call");
		});
		await state.refresh(exec, "tilth");
		expect(state.mode).toBe("config");
	});

	it("falls back to the binary when no server is configured", async () => {
		const state = createAvailabilityState();
		const exec = fakeExec((cmd, args) => {
			if (cmd === "mcporter") return { stdout: "", stderr: "not found", code: 1, killed: false };
			if (cmd === "tilth" && args[0] === "--version")
				return { stdout: "tilth 0.10.1", stderr: "", code: 0, killed: false };
			throw new Error("unexpected call");
		});
		await state.refresh(exec, "tilth");
		expect(state.mode).toBe("binary");
	});

	it("falls back to npx when the binary is missing", async () => {
		const state = createAvailabilityState();
		const exec = fakeExec((cmd, args) => {
			if (cmd === "mcporter") return { stdout: "", stderr: "nope", code: 1, killed: false };
			if (cmd === "tilth") return { stdout: "", stderr: "not installed", code: 127, killed: false };
			if (cmd === "npx" && args[0] === "--version") return { stdout: "10.x", stderr: "", code: 0, killed: false };
			throw new Error("unexpected call");
		});
		await state.refresh(exec, "tilth");
		expect(state.mode).toBe("npx");
	});

	it("becomes unavailable when nothing works", async () => {
		const state = createAvailabilityState();
		const exec = fakeExec(() => ({ stdout: "", stderr: "nope", code: 1, killed: false }));
		await state.refresh(exec, "tilth");
		expect(state.mode).toBe("unavailable");
	});

	it("treats probe crashes (e.g. timeout throws) as failures, not crashes", async () => {
		const state = createAvailabilityState();
		const exec: Exec = async () => {
			throw new Error("timed out");
		};
		await state.refresh(exec, "tilth");
		expect(state.mode).toBe("unavailable");
	});

	it("treats a killed probe (code 0 via signal-death) as a failure", async () => {
		const state = createAvailabilityState();
		const exec = fakeExec((cmd) => ({
			stdout: cmd === "tilth" ? "tilth 0.10.1" : "{}",
			stderr: "",
			code: 0,
			killed: true,
		}));
		await state.refresh(exec, "tilth");
		expect(state.mode).toBe("unavailable");
	});

	it("starts undefined before the first refresh", () => {
		const state = createAvailabilityState();
		expect(state.mode).toBeUndefined();
	});
});

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

describe("config — loading and precedence", () => {
	it("normalizes unknown fields away and keeps valid ones", () => {
		const c = normalizeConfig({
			serverName: "custom",
			callTimeoutMs: 120_000,
			hashlineCompat: false,
			nonsense: true,
		});
		expect(c).toEqual({
			serverName: "custom",
			callTimeoutMs: 120_000,
			hashlineCompat: false,
		});
	});

	it("rejects garbage types", () => {
		const c = normalizeConfig({ serverName: 42, callTimeoutMs: "x", hashlineCompat: "yes" });
		expect(c).toEqual({});
	});

	it("project config overrides global config", () => {
		const config = loadConfig({
			globalConfigPath: "/nonexistent-global.json",
			projectConfigPath: "/nonexistent-project.json",
		});
		expect(config).toEqual({
			serverName: "tilth",
			callTimeoutMs: 60_000,
			hashlineCompat: true,
		});
	});
});
