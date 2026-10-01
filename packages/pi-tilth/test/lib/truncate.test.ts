/**
 * Truncation pipeline coverage (tilth-tools spec: "Tool output is truncated
 * predictably with full output recoverable"). Exercises the real
 * `truncateHead` host defaults and the tmp-file spill, plus the savings
 * command's notify path.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSavingsCommand } from "../../src/commands/savings";
import { createAvailabilityState } from "../../src/lib/availability";
import { TransportError } from "../../src/lib/result";
import { applyTruncation } from "../../src/lib/truncate";
import type { TilthToolDeps } from "../../src/toolkit";
import { asTilthTransport, createFakeTransport } from "../helpers/fake-transport";

describe("applyTruncation", () => {
	it("passes small output through verbatim with no spill file", async () => {
		const outcome = await applyTruncation("short output\n");
		expect(outcome.truncated).toBe(false);
		expect(outcome.text).toBe("short output\n");
		expect(outcome.fullOutputPath).toBeUndefined();
	});

	it("truncates oversized output to its head and spills the full text to a tmp file", async () => {
		// Exceed both default budgets by a wide margin.
		const big = Array.from({ length: 20_000 }, (_, i) => `line ${i + 1} of the big output`).join("\n");

		const outcome = await applyTruncation(big);
		expect(outcome.truncated).toBe(true);
		expect(outcome.fullOutputPath).toBeDefined();

		// The pointer names the spill file…
		expect(outcome.text).toContain(`[Truncated. Full output: ${outcome.fullOutputPath}]`);
		// …whose content is the complete, untruncated output…
		const spilled = await readFile(outcome.fullOutputPath ?? "", "utf-8");
		expect(spilled).toBe(big);
		// …and the returned head is a proper prefix of it.
		const head = (outcome.text.split("\n[Truncated")[0] ?? "").trimEnd();
		expect(big.startsWith(head)).toBe(true);
	});

	it("spills to distinct files for back-to-back calls (no same-ms collision)", async () => {
		const big = `${"line\n".repeat(10_000)}`;
		const one = await applyTruncation(big);
		const two = await applyTruncation(big);
		expect(one.fullOutputPath).toBeDefined();
		expect(two.fullOutputPath).toBeDefined();
		expect(one.fullOutputPath).not.toBe(two.fullOutputPath);
	});
});

describe("/tilth-savings applies truncation to its notify", () => {
	let dir: string;
	const notify = vi.fn();

	type Handler = (args: unknown, ctx: ExtensionContext) => Promise<void>;

	/** Register the command against a fake pi + fake transport, and return its handler. */
	function captureHandler(
		handler: (toolName: string, params: Record<string, unknown>) => string | Promise<string>,
	): () => Handler {
		const availability = createAvailabilityState();
		availability.mode = "binary";
		const deps: TilthToolDeps = {
			transport: asTilthTransport(createFakeTransport(handler)),
			availability,
			config: { callTimeoutMs: 60_000, hashlineCompat: true },
			compat: null,
		};
		let handlerRef: Handler | null = null;
		const pi = {
			registerCommand: (_name: string, def: { handler: Handler }) => {
				handlerRef = def.handler;
			},
		} as unknown as ExtensionAPI;
		registerSavingsCommand(pi, deps);
		return () => {
			if (!handlerRef) throw new Error("command not registered");
			return handlerRef;
		};
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-tilth-truncate-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		notify.mockClear();
	});

	async function run(handler: Handler): Promise<void> {
		await handler([], {
			cwd: dir,
			ui: { notify },
		} as unknown as ExtensionContext);
	}

	it("truncates oversized savings output before notifying", async () => {
		const big = `${"savings row\n".repeat(20_000)}`;
		const getHandler = captureHandler(() => big);

		await run(getHandler());

		expect(notify).toHaveBeenCalledTimes(1);
		const message = notify.mock.calls[0]?.[0] as string;
		expect(message).toContain("[Truncated. Full output:");
		// The notified body is bounded, unlike the raw server output.
		expect(message.length).toBeLessThan(big.length);
	});

	it("notifies small savings output verbatim", async () => {
		const getHandler = captureHandler(() => "tilth saved you 1.2M tokens");

		await run(getHandler());

		expect(notify).toHaveBeenCalledWith("tilth saved you 1.2M tokens", "info");
	});

	it("notifies the unavailable-transport message instead of calling the server", async () => {
		// tilth-savings-command spec Scenario: Unavailable transport — the
		// command warns via notify; it never reaches the transport seam.
		const availability = createAvailabilityState();
		availability.mode = "unavailable";
		const deps: TilthToolDeps = {
			transport: asTilthTransport(
				createFakeTransport(() => {
					throw new Error("must not be called");
				}),
			),
			availability,
			config: { callTimeoutMs: 60_000, hashlineCompat: true },
			compat: null,
		};

		let handlerRef: Handler | null = null;
		const pi = {
			registerCommand: (_name: string, def: { handler: Handler }) => {
				handlerRef = def.handler;
			},
		} as unknown as ExtensionAPI;
		const getHandler = (): Handler => {
			if (handlerRef === null) throw new Error("command not registered");
			return handlerRef;
		};
		registerSavingsCommand(pi, deps);

		await getHandler()([], {
			cwd: dir,
			ui: { notify },
		} as unknown as ExtensionContext);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0]?.[0])).toContain("tilth is not available");
		expect(notify.mock.calls[0]?.[1]).toBe("warning");
	});

	it("warns on transport failure instead of throwing", async () => {
		const getHandler = captureHandler(() => {
			throw new TransportError("tilth MCP transport error: connection refused");
		});

		await run(getHandler());

		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0]?.[0])).toContain("connection refused");
		expect(notify.mock.calls[0]?.[1]).toBe("warning");
	});
});
