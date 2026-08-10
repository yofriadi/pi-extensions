import { execFile, execFileSync, execSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
	if (commandAvailability.has(command)) {
		return commandAvailability.get(command)!;
	}

	let available = false;
	if (process.platform === "win32") {
		try {
			execFileSync("where.exe", [command], { stdio: "ignore" });
			available = true;
		} catch {
			try {
				execSync(`command -v ${command}`, { stdio: "ignore" });
				available = true;
			} catch {
				available = false;
			}
		}
	} else {
		try {
			execSync(`command -v ${command}`, { stdio: "ignore" });
			available = true;
		} catch {
			available = false;
		}
	}

	commandAvailability.set(command, available);
	return available;
}

export function isHerdrAvailable(): boolean {
	return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function parseHerdrJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function extractHerdrPaneId(output: string, context: string): string {
	const parsed = parseHerdrJson(output);
	const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane?.pane_id;
	if (typeof paneId !== "string" || !paneId) {
		throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
	}
	return paneId;
}

function extractHerdrRootPaneId(output: string, context: string): string {
	const parsed = parseHerdrJson(output);
	const paneId = (parsed as { result?: { root_pane?: { pane_id?: unknown } } })?.result?.root_pane?.pane_id;
	if (typeof paneId !== "string" || !paneId) {
		throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
	}
	return paneId;
}

/** Synchronous herdr invocation. `timeoutMs` bounds the subprocess so a hung
 * `pane get`/`pane close` cannot block cleanup indefinitely; a timeout throws
 * and is classified as a transient failure by callers. */
function herdrExec(args: string[], timeoutMs?: number): string {
	return execFileSync("herdr", args, timeoutMs ? { encoding: "utf8", timeout: timeoutMs } : { encoding: "utf8" });
}

async function herdrExecAsync(args: string[]): Promise<string> {
	// Timeout prevents a hung herdr subprocess from permanently stalling the
	// completion watcher's poll loop. Without it, a pane in a transitional
	// state (e.g. closing) can hang `pane read`/`pane get` indefinitely,
	// blocking the pane-missing detection that would otherwise resolve the watcher.
	const { stdout } = await execFileAsync("herdr", args, {
		encoding: "utf8",
		timeout: 5000,
	});
	return stdout;
}

export type HerdrFailureClass = "transient" | "permanent";

/** Classify pane-control failures for retry. Missing pane_id is always a failure. */
export function classifyHerdrFailure(error: unknown): HerdrFailureClass {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	// Permanent: usage / invalid args / not found of a specific resource for control ops
	if (
		/unknown (flag|option|command)|invalid (argument|value|direction|pane)|usage:|unrecognized|not a valid|required argument|too many arguments|pane_not_found|not_found/.test(
			lower,
		)
	) {
		return "permanent";
	}
	// Transient: socket / control-plane / empty pane id after exit 0 / racey layout
	if (
		/socket|econnrefused|econnreset|eagain|enotconn|control.plane|timed out|timeout|temporarily|connection refused|broken pipe|unexpected herdr.*output|\(empty\)|try again/.test(
			lower,
		)
	) {
		return "transient";
	}
	// Default: bounded retry can absorb flakes; permanent patterns above fail fast.
	return "transient";
}

export function getPaneRetryBudget(): number {
	const raw = process.env.PI_SUBAGENT_HERDR_PANE_RETRIES?.trim();
	if (!raw) return 2;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

export function withPaneRetries<T>(label: string, fn: () => T): T {
	const budget = getPaneRetryBudget();
	let attempt = 0;
	let lastError: unknown;
	while (attempt <= budget) {
		try {
			return fn();
		} catch (error) {
			lastError = error;
			const klass = classifyHerdrFailure(error);
			if (klass === "permanent" || attempt >= budget) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`herdr ${label} failed after ${attempt + 1} attempt(s) (${klass}): ${detail}`);
			}
			attempt += 1;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getHerdrParentPaneId(): string {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) {
		throw new Error("HERDR_PANE_ID not set");
	}
	return paneId;
}

function getHerdrCurrentPaneInfo(): {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
} {
	const paneId = process.env.HERDR_PANE_ID;
	const tabId = process.env.HERDR_TAB_ID;
	const workspaceId = process.env.HERDR_WORKSPACE_ID;

	// Fall back to `herdr pane current` if any identity env var is missing —
	// older herdr versions may not set all three.
	if (!paneId || !tabId || !workspaceId) {
		const output = herdrExec(["pane", "current"]);
		const parsed = parseHerdrJson(output);
		const pane = (parsed as { result?: { pane?: unknown } } | null)?.result?.pane as
			| { pane_id?: string; tab_id?: string; workspace_id?: string }
			| undefined;
		if (!pane?.pane_id || !pane?.tab_id || !pane?.workspace_id) {
			throw new Error(`Unexpected herdr pane current output: ${output.trim() || "(empty)"}`);
		}
		return {
			pane_id: pane.pane_id,
			tab_id: pane.tab_id,
			workspace_id: pane.workspace_id,
		};
	}

	return { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId };
}

function buildTabCreateArgs(name: string, cwd: string, workspaceId: string): string[] {
	return ["tab", "create", "--workspace", workspaceId, "--label", name, "--cwd", cwd, "--no-focus"];
}

export function createHerdrSurface(name: string, cwd = process.cwd()): string {
	// Create a new tab per subagent so parallel spawns each get a full tab
	// instead of ever-narrower splits of the parent pane. Target the current
	// workspace explicitly because Herdr's implicit default may be another space.
	return withPaneRetries("tab create", () => {
		const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
		const output = herdrExec(buildTabCreateArgs(name, cwd, workspaceId));
		const paneId = extractHerdrRootPaneId(output, "tab create");
		try {
			herdrExec(["pane", "rename", paneId, name]);
		} catch {
			// Optional — pane label is cosmetic.
		}
		return paneId;
	});
}

export function createHerdrSurfaceSplit(
	name: string,
	direction: "right" | "down",
	targetPaneId?: string,
	cwd = process.cwd(),
): string {
	return withPaneRetries("pane split", () => {
		const parentPaneId = targetPaneId ?? getHerdrParentPaneId();
		const output = herdrExec(["pane", "split", parentPaneId, "--direction", direction, "--no-focus", "--cwd", cwd]);
		// extractHerdrPaneId throws when .result.pane.pane_id is missing (even on exit 0).
		const paneId = extractHerdrPaneId(output, "pane split");
		try {
			herdrExec(["pane", "rename", paneId, name]);
		} catch {
			// Optional.
		}
		return paneId;
	});
}

export interface HerdrPaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface HerdrLayoutPane {
	paneId: string;
	rect: HerdrPaneRect;
	focused?: boolean;
}

export interface HerdrPaneLayout {
	area?: HerdrPaneRect;
	panes: HerdrLayoutPane[];
}

/** Query `herdr pane layout --pane <id>`; returns null when unavailable/malformed. */
export function getHerdrPaneLayout(paneId: string): HerdrPaneLayout | null {
	try {
		const output = herdrExec(["pane", "layout", "--pane", paneId]);
		const parsed = parseHerdrJson(output) as {
			result?: {
				layout?: {
					area?: Partial<HerdrPaneRect>;
					panes?: Array<{ pane_id?: unknown; focused?: unknown; rect?: Partial<HerdrPaneRect> }>;
				};
			};
		} | null;
		const layout = parsed?.result?.layout;
		if (!layout || !Array.isArray(layout.panes)) return null;
		const panes: HerdrLayoutPane[] = [];
		for (const entry of layout.panes) {
			if (typeof entry?.pane_id !== "string" || !entry.pane_id) continue;
			const r = entry.rect;
			if (
				!r ||
				typeof r.x !== "number" ||
				typeof r.y !== "number" ||
				typeof r.width !== "number" ||
				typeof r.height !== "number"
			) {
				continue;
			}
			panes.push({
				paneId: entry.pane_id,
				rect: { x: r.x, y: r.y, width: r.width, height: r.height },
				focused: entry.focused === true,
			});
		}
		const area =
			layout.area &&
			typeof layout.area.x === "number" &&
			typeof layout.area.y === "number" &&
			typeof layout.area.width === "number" &&
			typeof layout.area.height === "number"
				? {
						x: layout.area.x,
						y: layout.area.y,
						width: layout.area.width,
						height: layout.area.height,
					}
				: undefined;
		return { area, panes };
	} catch {
		return null;
	}
}

/** Synchronous pane existence check via `herdr pane get`. */
export function herdrPaneExists(paneId: string): boolean {
	try {
		const output = herdrExec(["pane", "get", paneId]);
		const result = parsePaneGetOutput(output, paneId);
		return result.kind === "present";
	} catch (error: any) {
		const parsed = parsePaneGetError(error);
		return parsed.kind === "present";
	}
}

/**
 * Synchronous tri-state pane inspection via `herdr pane get`.
 * - present: pane is reachable.
 * - missing: server confirmed the pane is gone (pane_not_found).
 * - unavailable: command failed (e.g. transient socket error); callers must
 *   NOT treat this as "pane gone" — closing decisions require an explicit
 *   `missing` result so a transient `pane get` failure can never orphan a
 *   still-running child pane.
 */
export function inspectHerdrPaneSync(paneId: string): PaneInspectionResult {
	try {
		const output = herdrExec(["pane", "get", paneId], 5000);
		return parsePaneGetOutput(output, paneId);
	} catch (error: any) {
		return parsePaneGetError(error);
	}
}

export function readHerdrScreen(surface: string, lines = 50): string {
	// `visible` is reliable for freshly created panes where herdr's `recent`
	// scrollback may not be populated yet.
	return herdrExec(["pane", "read", surface, "--source", "visible", "--lines", String(lines)]);
}

export async function readHerdrScreenAsync(surface: string, lines = 50): Promise<string> {
	return herdrExecAsync(["pane", "read", surface, "--source", "visible", "--lines", String(lines)]);
}

export type { HerdrAgentStatus, PaneInspection } from "./lifecycle.ts";

type PaneInspectionResult =
	| { kind: "present"; agent?: string; agentStatus: "idle" | "working" | "blocked" | "done" | "unknown" }
	| { kind: "missing"; error?: string }
	| { kind: "unavailable"; error: string };

function parsePaneGetOutput(output: string, surface: string): PaneInspectionResult {
	const parsed = parseHerdrJson(output) as {
		result?: { pane?: unknown };
		error?: { code?: unknown; message?: unknown };
	} | null;
	const errorObj = parsed?.error;
	if (errorObj?.code === "pane_not_found" || errorObj?.code === "not_found") {
		return { kind: "missing", error: typeof errorObj.message === "string" ? errorObj.message : "pane not found" };
	}
	const pane = parsed?.result?.pane;
	if (!pane || typeof pane !== "object") return { kind: "unavailable", error: "pane get returned no pane record" };
	const record = pane as { pane_id?: unknown; agent?: unknown; agent_status?: unknown };
	if (record.pane_id !== surface) return { kind: "unavailable", error: "pane id mismatch" };
	const agent = typeof record.agent === "string" ? record.agent : undefined;
	const rawStatus = typeof record.agent_status === "string" ? record.agent_status : "unknown";
	const agentStatus =
		rawStatus === "idle" ||
		rawStatus === "working" ||
		rawStatus === "blocked" ||
		rawStatus === "done" ||
		rawStatus === "unknown"
			? rawStatus
			: "unknown";
	return { kind: "present", ...(agent ? { agent } : {}), agentStatus };
}

function parsePaneGetError(error: any): PaneInspectionResult {
	for (const raw of [error?.stderr, error?.stdout]) {
		if (typeof raw !== "string" || !raw.trim()) continue;
		try {
			const parsed = parsePaneGetOutput(raw, "");
			if (parsed.kind === "missing") return parsed;
		} catch {
			// A CLI may emit plain diagnostics on one stream and structured JSON on
			// the other. Parse each stream independently before giving up.
		}
		// Older/alternate Herdr builds may print the stable error code as plain
		// text rather than JSON. Only match explicit identifiers, not generic
		// prose such as "pane unavailable".
		if (/\b(?:pane_not_found|not_found)\b/.test(raw)) {
			return { kind: "missing", error: raw.trim() };
		}
	}
	const message = error?.message ? String(error.message) : "herdr pane get failed";
	return { kind: "unavailable", error: message };
}

/**
 * Structured pane query.
 * - present: pane is reachable; agent/agentStatus may be present when detected
 * - missing: server responded, pane is gone
 * - unavailable: server command failed; caller should keep polling
 */
export async function inspectHerdrPane(surface: string): Promise<PaneInspectionResult> {
	try {
		return parsePaneGetOutput(await herdrExecAsync(["pane", "get", surface]), surface);
	} catch (error: any) {
		return parsePaneGetError(error);
	}
}

export function sendHerdrCommand(surface: string, command: string): void {
	// pane run sends the text and Enter in a single socket request, avoiding
	// a race where Enter could arrive before the text is fully processed.
	herdrExec(["pane", "run", surface, command]);
}

export function sendHerdrEscape(surface: string): void {
	herdrExec(["pane", "send-keys", surface, "Escape"]);
}

export function closeHerdrSurface(surface: string): void {
	herdrExec(["pane", "close", surface], 5000);
}

export function renameHerdrTab(title: string): void {
	const { tab_id: tabId } = getHerdrCurrentPaneInfo();
	herdrExec(["tab", "rename", tabId, title]);
}

export function renameHerdrWorkspace(title: string): void {
	const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
	herdrExec(["workspace", "rename", workspaceId, title]);
}

export const __herdrTest__ = {
	buildTabCreateArgs,
	parseHerdrJson,
	extractHerdrPaneId,
	classifyHerdrFailure,
	getPaneRetryBudget,
	withPaneRetries,
	getHerdrPaneLayout,
	herdrPaneExists,
	inspectHerdrPaneSync,
	createHerdrSurfaceSplit,
	extractHerdrRootPaneId,
	parsePaneGetOutput,
	parsePaneGetError,
	herdrExecAsync,
};
