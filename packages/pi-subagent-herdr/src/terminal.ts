import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	closeHerdrSurface,
	createHerdrSurface,
	createHerdrSurfaceSplit,
	getHerdrPaneLayout,
	type HerdrLayoutPane,
	type HerdrPaneLayout,
	type HerdrPaneRect,
	herdrPaneExists,
	inspectHerdrPane,
	inspectHerdrPaneSync,
	isHerdrAvailable,
	readHerdrScreen,
	readHerdrScreenAsync,
	renameHerdrTab,
	renameHerdrWorkspace,
	sendHerdrCommand,
	sendHerdrEscape,
	withPaneRetries,
} from "./herdr.ts";

export type { HerdrPaneLayout, HerdrLayoutPane, HerdrPaneRect };
export { getHerdrPaneLayout, herdrPaneExists, inspectHerdrPaneSync };

export type PaneId = string;
export type SplitDirection = "right" | "down";

const SETUP_HINT = "Start pi inside herdr (`herdr`, then run `pi`).";

export function isTerminalAvailable(): boolean {
	return isHerdrAvailable();
}

export function terminalSetupHint(): string {
	return SETUP_HINT;
}

function assertTerminalAvailable(): void {
	if (!isTerminalAvailable()) throw new Error(`herdr is not available. ${SETUP_HINT}`);
}

export function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a new herdr tab and return its root pane ID. */
export function createSubagentPane(name: string, cwd = process.cwd()): PaneId {
	assertTerminalAvailable();
	return createHerdrSurface(name, cwd);
}

/** Split a herdr pane (default: caller pane) and return the child pane ID. */
export function splitCurrentPane(
	name: string,
	direction: SplitDirection,
	targetPaneId?: string,
	cwd = process.cwd(),
): PaneId {
	assertTerminalAvailable();
	return createHerdrSurfaceSplit(name, direction, targetPaneId, cwd);
}

export function renameCurrentTab(title: string): void {
	assertTerminalAvailable();
	renameHerdrTab(title);
}

export function renameCurrentWorkspace(title: string): void {
	assertTerminalAvailable();
	renameHerdrWorkspace(title);
}

export function runInPane(paneId: PaneId, command: string): void {
	assertTerminalAvailable();
	sendHerdrCommand(paneId, command);
}

export function interruptPane(paneId: PaneId): void {
	assertTerminalAvailable();
	sendHerdrEscape(paneId);
}

export function runScriptInPane(
	paneId: PaneId,
	command: string,
	options?: { scriptPath?: string; scriptPreamble?: string },
): string {
	const scriptPath =
		options?.scriptPath ??
		join(tmpdir(), "pi-subagent-herdr-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
	mkdirSync(dirname(scriptPath), { recursive: true });

	const scriptLines = ["#!/bin/bash"];
	if (options?.scriptPreamble) scriptLines.push(options.scriptPreamble.trimEnd());
	scriptLines.push(command);
	writeFileSync(scriptPath, `${scriptLines.join("\n")}\n`, { mode: 0o755 });

	runInPane(paneId, `bash ${shellQuote(scriptPath)}`);
	return scriptPath;
}

export function readPane(paneId: PaneId, lines = 50): string {
	assertTerminalAvailable();
	return readHerdrScreen(paneId, lines);
}

export async function readPaneAsync(paneId: PaneId, lines = 50): Promise<string> {
	assertTerminalAvailable();
	return readHerdrScreenAsync(paneId, lines);
}

export type { HerdrAgentStatus, PaneInspection } from "./lifecycle.ts";

export async function inspectPane(paneId: PaneId): Promise<import("./lifecycle.ts").PaneInspection> {
	assertTerminalAvailable();
	const result = await inspectHerdrPane(paneId);
	if (result.kind === "present") {
		return { ...result, observedAt: Date.now() };
	}
	return result;
}

export function closePane(paneId: PaneId): void {
	assertTerminalAvailable();
	closeHerdrSurface(paneId);
}

/**
 * Close a subagent pane without orphaning it on a transient `pane get` failure.
 *
 * Only an explicit `missing` result (pane_not_found) is treated as "nothing to
 * close." When the pane is `present` — or the probe is `unavailable` and state
 * cannot be confirmed — the pane is closed directly with classified retries so a
 * transient Herdr failure can never leave an autonomous child process running
 * after its parent has moved on.
 */
export function safeCloseSubagentPane(surface: string): void {
	assertTerminalAvailable();
	const inspection = inspectHerdrPaneSync(surface);
	if (!shouldCloseSubagentPane(inspection)) return;
	withPaneRetries(`pane close ${surface}`, () => closeHerdrSurface(surface));
}

/**
 * Decide whether a pane should be closed based on its inspection result.
 *
 * Only an explicit `missing` result skips the close; `present` and
 * `unavailable` both close so a transient `pane get` failure can never
 * orphan a still-running child pane. Exported for direct unit testing.
 */
export function shouldCloseSubagentPane(inspection: {
	kind: "present" | "missing" | "unavailable";
	error?: string;
}): boolean {
	return inspection.kind !== "missing";
}
