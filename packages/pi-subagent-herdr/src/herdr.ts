import { execFile, execFileSync, execSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
	const cached = commandAvailability.get(command);
	if (cached !== undefined) {
		return cached;
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

export type HerdrPaneInfo = { pane_id: string; tab_id: string; workspace_id: string };

export function getHerdrCurrentPaneInfo(): HerdrPaneInfo {
	return paneInfoFromEnvironment() ?? paneInfoFromCurrentCommand();
}

function paneInfoFromEnvironment(): HerdrPaneInfo | undefined {
	const pane_id = process.env.HERDR_PANE_ID;
	const tab_id = process.env.HERDR_TAB_ID;
	const workspace_id = process.env.HERDR_WORKSPACE_ID;
	if (!pane_id || !tab_id || !workspace_id) return undefined;
	return { pane_id, tab_id, workspace_id };
}

function paneInfoFromCurrentCommand(): HerdrPaneInfo {
	const output = herdrExec(["pane", "current"]);
	const pane = (parseHerdrJson(output) as { result?: { pane?: unknown } } | null)?.result?.pane;
	const paneInfo = parsePaneInfo(pane);
	if (!paneInfo) throw unexpectedPaneInfoError(output);
	return paneInfo;
}

function parsePaneInfo(value: unknown): HerdrPaneInfo | undefined {
	const pane = recordValue(value);
	return pane ? paneInfoFromRecord(pane) : undefined;
}

function paneInfoFromRecord(pane: Record<string, unknown>): HerdrPaneInfo | undefined {
	const pane_id = nonEmptyString(pane.pane_id);
	if (!pane_id) return undefined;
	const tab_id = nonEmptyString(pane.tab_id);
	if (!tab_id) return undefined;
	const workspace_id = nonEmptyString(pane.workspace_id);
	if (!workspace_id) return undefined;
	return { pane_id, tab_id, workspace_id };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value || undefined;
}

function unexpectedPaneInfoError(output: string): Error {
	return new Error(`Unexpected herdr pane current output: ${output.trim() || "(empty)"}`);
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

type HerdrLayoutResponse = { result?: { layout?: unknown } };

/** Query `herdr pane layout --pane <id>`; returns null when unavailable/malformed. */
export function getHerdrPaneLayout(paneId: string): HerdrPaneLayout | null {
	try {
		return parseHerdrPaneLayout(herdrExec(["pane", "layout", "--pane", paneId]));
	} catch {
		return null;
	}
}

function parseHerdrPaneLayout(output: string): HerdrPaneLayout | null {
	const layout = (parseHerdrJson(output) as HerdrLayoutResponse | null)?.result?.layout;
	return parseHerdrLayout(layout);
}

function parseHerdrLayout(value: unknown): HerdrPaneLayout | null {
	const layout = recordValue(value);
	if (!layout) return null;
	const panes = parseHerdrLayoutPanes(layout.panes);
	return panes ? { area: parseHerdrPaneRect(layout.area), panes } : null;
}

function parseHerdrLayoutPanes(value: unknown): HerdrLayoutPane[] | null {
	if (!Array.isArray(value)) return null;
	return value.map(parseHerdrLayoutPane).filter(isDefined);
}

function parseHerdrLayoutPane(value: unknown): HerdrLayoutPane | undefined {
	const pane = recordValue(value);
	if (!pane) return undefined;
	const paneId = nonEmptyString(pane.pane_id);
	if (!paneId) return undefined;
	const rect = parseHerdrPaneRect(pane.rect);
	if (!rect) return undefined;
	return { paneId, rect, focused: pane.focused === true };
}

function parseHerdrPaneRect(value: unknown): HerdrPaneRect | undefined {
	const rect = recordValue(value);
	if (!rect) return undefined;
	const values = [rect.x, rect.y, rect.width, rect.height];
	if (!values.every(isNumber)) return undefined;
	const [x, y, width, height] = values;
	return { x, y, width, height };
}

function isNumber(value: unknown): value is number {
	return typeof value === "number";
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
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

type PaneInspectionResult =
	| { kind: "present"; agent?: string; agentStatus: "idle" | "working" | "blocked" | "done" | "unknown" }
	| { kind: "missing"; error?: string }
	| { kind: "unavailable"; error: string };

type PaneGetPayload = {
	result?: { pane?: unknown };
	error?: { code?: unknown; message?: unknown };
};

const herdrAgentStatuses = new Set(["idle", "working", "blocked", "done", "unknown"]);

function parsePaneGetOutput(output: string, surface: string): PaneInspectionResult {
	const payload = parseHerdrJson(output) as PaneGetPayload | null;
	return missingPaneFromPayload(payload) ?? presentPaneFromPayload(payload, surface);
}

function missingPaneFromPayload(payload: PaneGetPayload | null): PaneInspectionResult | undefined {
	const message = missingPanePayloadMessage(payload);
	return message ? missingPaneResult(message) : undefined;
}

function missingPanePayloadMessage(payload: PaneGetPayload | null): string | undefined {
	const error = payload?.error;
	if (!isMissingPaneCode(error?.code)) return undefined;
	return errorMessageOrFallback(error?.message, "pane not found");
}

function isMissingPaneCode(code: unknown): boolean {
	return code === "pane_not_found" || code === "not_found";
}

function missingPaneResult(error: string): PaneInspectionResult {
	return { kind: "missing", error };
}

function presentPaneFromPayload(payload: PaneGetPayload | null, surface: string): PaneInspectionResult {
	const pane = recordValue(payload?.result?.pane);
	if (!pane) return unavailablePane("pane get returned no pane record");
	if (pane.pane_id !== surface) return unavailablePane("pane id mismatch");
	return { kind: "present", ...optionalPaneAgent(pane.agent), agentStatus: paneAgentStatus(pane.agent_status) };
}

function unavailablePane(error: string): PaneInspectionResult {
	return { kind: "unavailable", error };
}

function optionalPaneAgent(value: unknown): { agent?: string } {
	return typeof value === "string" ? { agent: value } : {};
}

function paneAgentStatus(value: unknown): Extract<PaneInspectionResult, { kind: "present" }>["agentStatus"] {
	return typeof value === "string" && herdrAgentStatuses.has(value) ? (value as any) : "unknown";
}

function parsePaneGetError(error: any): PaneInspectionResult {
	return (
		missingPaneFromCommandStreams(error) ??
		unavailablePane(errorMessageOrFallback(error?.message, "herdr pane get failed"))
	);
}

function missingPaneFromCommandStreams(error: any): PaneInspectionResult | undefined {
	return firstMissingPane(commandOutputStreams(error));
}

function commandOutputStreams(error: any): unknown[] {
	return [error?.stderr, error?.stdout];
}

function firstMissingPane(outputs: unknown[]): PaneInspectionResult | undefined {
	for (const output of outputs) {
		const missing = missingPaneFromCommandOutput(output);
		if (missing) return missing;
	}
	return undefined;
}

function missingPaneFromCommandOutput(output: unknown): PaneInspectionResult | undefined {
	const text = nonBlankOutput(output);
	if (!text) return undefined;
	return parseMissingPaneOutput(text) ?? plainMissingPaneOutput(text);
}

function nonBlankOutput(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim() ? value : undefined;
}

function plainMissingPaneOutput(output: string): PaneInspectionResult | undefined {
	return /\b(?:pane_not_found|not_found)\b/.test(output) ? missingPaneResult(output.trim()) : undefined;
}

function parseMissingPaneOutput(output: string): PaneInspectionResult | undefined {
	try {
		const parsed = parsePaneGetOutput(output, "");
		return parsed.kind === "missing" ? parsed : undefined;
	} catch {
		// A CLI may write JSON to one stream and plain diagnostics to the other.
		return undefined;
	}
}

function errorMessageOrFallback(value: unknown, fallback: string): string {
	return typeof value === "string" && value ? value : fallback;
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
