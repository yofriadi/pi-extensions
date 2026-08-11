import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentActivityState } from "./activity.ts";
import { rememberTuiSize } from "./layout.ts";
import { type LifecycleProjection, projectLifecycle, type SubagentLifecycle } from "./lifecycle.ts";
import { pendingDeliveries, queuedSubagents, runningSubagents, stickyTerminalRuns } from "./state.ts";
import type { DeliveryWaitKind, PendingDelivery, QueuedSubagent, RunningSubagent, StickyTerminalRun } from "./types.ts";

export const MAX_QUEUED_WIDGET_ROWS = 3;
export const MAX_STICKY_WIDGET_ROWS = 3;
export const MIN_WIDGET_RUN_ID_LENGTH = 8;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

export function formatWidgetDuration(durationMs: number): string {
	const tenths = Math.max(0, Math.floor(durationMs / 100)) / 10;
	if (tenths < 60) return Number.isInteger(tenths) ? `${tenths}s` : `${tenths.toFixed(1)}s`;
	const totalSeconds = Math.floor(tenths);
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

export function sanitizeWidgetText(value: string): string {
	return value
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, " ")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
		.replace(/\x1b[@-_]/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function subagentRowHeader(theme: any, icon: string, name: string, agentTag: string, runTag: string): string {
	return `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${runTag}`;
}

function formatDeliveryWaitLabel(kind: DeliveryWaitKind): string {
	if (kind === "barrier") return "held · foreground busy";
	if (kind === "turn-boundary") return "awaiting turn boundary";
	return "confirming delivery";
}

function formatAgentDisplayName(agent: string | undefined, fallback: string): string {
	if (!agent) return sanitizeWidgetText(fallback).trim() || "subagent";
	return agent
		.split(/[-_.\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function formatContextTokens(tokens: number): string {
	if (Math.abs(tokens) >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
	if (Math.abs(tokens) >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens)}`;
}

export function buildWidgetRunIdLabels(ids: string[]): Map<string, string> {
	const sanitizedIds = Array.from(new Set(ids)).map((id) => [id, sanitizeWidgetText(id).trim()] as const);
	const opaqueIds = sanitizedIds.filter(([, id]) => /^[0-9a-f]{16,}$/i.test(id));
	const labels = new Map<string, string>();
	for (const [originalId, safeId] of sanitizedIds) {
		if (!/^[0-9a-f]{16,}$/i.test(safeId)) {
			labels.set(originalId, safeId);
			continue;
		}
		let length = Math.min(MIN_WIDGET_RUN_ID_LENGTH, safeId.length);
		while (
			length < safeId.length &&
			opaqueIds.some(([, other]) => other !== safeId && other.startsWith(safeId.slice(0, length)))
		) {
			length += 1;
		}
		labels.set(originalId, safeId.slice(0, length));
	}
	return labels;
}

function fitWidgetLine(prefix: string, content: string, width: number): string {
	if (width <= 0) return "";
	const fittedPrefix = truncateToWidth(prefix, width);
	const remaining = Math.max(0, width - visibleWidth(fittedPrefix));
	return `${fittedPrefix}${truncateToWidth(content, remaining)}`;
}

function fitIdentityContent(params: {
	glyph: string;
	displayName: string;
	id: string;
	admissionClass?: string;
	duration?: string;
	width: number;
}): string {
	const safeName = sanitizeWidgetText(params.displayName).trim() || "subagent";
	const safeId = sanitizeWidgetText(params.id).trim();
	const beforeName = `${params.glyph} `;
	const afterName = `${safeId ? ` · [${safeId}]` : ""}${params.admissionClass ? ` · ${params.admissionClass}` : ""}`;
	const duration = params.duration ? ` · ${params.duration}` : "";
	const full = `${beforeName}${safeName}${afterName}${duration}`;
	if (visibleWidth(full) <= params.width) return full;
	const withoutDuration = `${beforeName}${safeName}${afterName}`;
	if (visibleWidth(withoutDuration) <= params.width) return withoutDuration;
	const nameWidth = Math.max(0, params.width - visibleWidth(beforeName) - visibleWidth(afterName));
	return truncateToWidth(`${beforeName}${truncateToWidth(safeName, nameWidth)}${afterName}`, params.width);
}

interface ActivityTelemetryParts {
	turns?: string;
	tools?: string;
	tokenBase?: string;
	percent?: string;
	compactions?: string;
}

function telemetryParts(activity: SubagentActivityState | undefined, theme: Theme): ActivityTelemetryParts {
	if (!activity) return {};
	return {
		turns: activity.turnIndex == null ? undefined : `↻${activity.turnIndex}`,
		tools: activity.toolCount == null ? undefined : `⚙${activity.toolCount}`,
		tokenBase: activity.contextTokens == null ? undefined : `◈${formatContextTokens(activity.contextTokens)}`,
		percent: renderContextPercent(activity, theme),
		compactions: renderCompactionCount(activity, theme),
	};
}

function renderContextPercent(activity: SubagentActivityState, theme: Theme): string | undefined {
	const percent = deriveContextPercent(activity);
	if (percent == null) return undefined;
	return theme.fg(contextPercentColor(percent), `${Math.round(percent)}%`);
}

function deriveContextPercent(activity: SubagentActivityState): number | undefined {
	if (activity.contextPercent !== undefined) return activity.contextPercent ?? undefined;
	if (activity.contextTokens == null || activity.contextWindow == null || activity.contextWindow <= 0)
		return undefined;
	return (activity.contextTokens / activity.contextWindow) * 100;
}

function contextPercentColor(percent: number): "dim" | "warning" | "error" {
	if (percent < 70) return "dim";
	if (percent < 85) return "warning";
	return "error";
}

function renderCompactionCount(activity: SubagentActivityState, theme: Theme): string | undefined {
	const count = activity.compactionCount ?? 0;
	return count > 0 ? theme.fg("dim", `⇊${count}`) : undefined;
}

function buildTelemetryChunks(parts: ActivityTelemetryParts): string[] {
	const chunks = [parts.turns, parts.tools].filter((part): part is string => part != null);
	if (parts.tokenBase) {
		const annotations = [parts.percent, parts.compactions].filter((part): part is string => part != null);
		chunks.push(`${parts.tokenBase}${annotations.length > 0 ? ` (${annotations.join(" · ")})` : ""}`);
	} else if (parts.compactions) {
		chunks.push(parts.compactions);
	}
	return chunks;
}

function fitActivityContent(
	lead: string | undefined,
	activity: SubagentActivityState | undefined,
	theme: Theme,
	width: number,
	activityPrefix = "⎿  ",
): string {
	const parts = telemetryParts(activity, theme);
	const render = () =>
		[lead, ...buildTelemetryChunks(parts)].filter((part): part is string => Boolean(part)).join(" · ");
	const fits = () => visibleWidth(`${activityPrefix}${render()}`) <= width;
	if (!fits()) parts.compactions = undefined;
	if (!fits()) parts.percent = undefined;
	if (!fits()) parts.tools = undefined;
	if (!fits()) parts.turns = undefined;
	return truncateToWidth(`${activityPrefix}${render()}`, width);
}

function lifecycleGlyph(kind: LifecycleProjection["kind"], now: number): string {
	if (kind === "starting" || kind === "running" || kind === "active")
		return SPINNER_FRAMES[Math.floor(now / 1000) % SPINNER_FRAMES.length];
	if (kind === "blocked") return "◆";
	if (kind === "waiting") return "◷";
	if (kind === "interrupted") return "■";
	if (kind === "stalled") return "⚠";
	if (kind === "failed") return "✗";
	return "◌";
}

function lifecycleActivityLead(
	agent: RunningSubagent,
	projection: LifecycleProjection,
	now: number,
): string | undefined {
	const runLabel = agent.agent && agent.name !== agent.agent ? sanitizeWidgetText(agent.name).trim() : undefined;
	const duration = lifecycleStateDuration(projection, now);
	if (["starting", "running", "active"].includes(projection.kind)) return runLabel;
	if (projection.kind === "blocked") return joinLifecycleLead(`blocked${duration}`, runLabel);
	if (["waiting", "interrupted", "stalled"].includes(projection.kind)) return `${projection.kind}${duration}`;
	if (["finalizing", "completed", "failed"].includes(projection.kind)) return deliveryLifecycleLead(agent, now);
	return undefined;
}

function lifecycleStateDuration(projection: LifecycleProjection, now: number): string {
	return projection.stateDurationSince == null ? "" : ` ${formatWidgetDuration(now - projection.stateDurationSince)}`;
}

function joinLifecycleLead(state: string, runLabel: string | undefined): string {
	return [state, runLabel].filter(Boolean).join(" · ");
}

function deliveryLifecycleLead(agent: RunningSubagent, now: number): string {
	if (!agent.deliveryWait) return "finalizing…";
	return `${formatDeliveryWaitLabel(agent.deliveryWait.kind)} ${formatWidgetDuration(now - agent.deliveryWait.since)}`;
}

interface WidgetTreeItem {
	identity: (width: number) => string;
	activity?: (width: number) => string;
}

type RenderedWidgetRun = { agent: RunningSubagent; projection: LifecycleProjection };
type DisplayRunId = (id: string) => string;

export function renderSubagentWidgetLines(
	agents: RunningSubagent[],
	width: number,
	theme: Theme,
	queued: QueuedSubagent[] = [],
	pending: PendingDelivery[] = [],
	sticky: StickyTerminalRun[] = [],
	ensureLifecycle: (agent: RunningSubagent) => SubagentLifecycle = (agent) => agent.lifecycle,
): string[] {
	const now = Date.now();
	const rendered = renderLifecycleProjections(agents, ensureLifecycle, now);
	const displayRunId = createDisplayRunId(agents, queued, pending, sticky);
	const items = buildWidgetItems({ rendered, queued, pending, sticky, displayRunId, theme, now });
	return [renderWidgetHeader(rendered, queued, pending, theme, width), ...renderWidgetItems(items, width)];
}

function renderLifecycleProjections(
	agents: RunningSubagent[],
	ensureLifecycle: (agent: RunningSubagent) => SubagentLifecycle,
	now: number,
): RenderedWidgetRun[] {
	return agents.map((agent) => ({ agent, projection: projectLifecycle(ensureLifecycle(agent), now) }));
}

function renderWidgetHeader(
	rendered: RenderedWidgetRun[],
	queued: QueuedSubagent[],
	pending: PendingDelivery[],
	theme: Theme,
	width: number,
): string {
	const counts = widgetCounts(rendered, queued, pending);
	const liveWork = rendered.length > 0 || queued.length > 0 || counts.retrying > 0 || counts.awaitingRuntime > 0;
	const chunks = widgetCountChunks(rendered.length, queued.length, counts);
	const icon = theme.fg(liveWork ? "accent" : "muted", liveWork ? "●" : "○");
	const suffix = liveWork && chunks.length > 0 ? ` · ${chunks.join(" · ")}` : "";
	return truncateToWidth(`${icon} ${theme.bold("Subagents")}${suffix}`, Math.max(0, width));
}

function widgetCounts(rendered: RenderedWidgetRun[], queued: QueuedSubagent[], pending: PendingDelivery[]) {
	const active = rendered.filter(({ projection }) =>
		["active", "starting", "running", "blocked"].includes(projection.kind),
	).length;
	const awaitingRuntime = pending.filter((entry) => !entry.exhausted && entry.deferredSince !== undefined).length;
	const retrying = pending.filter((entry) => !entry.exhausted && entry.deferredSince === undefined).length;
	return {
		active,
		open: rendered.length - active,
		queued: queued.length,
		awaitingRuntime,
		retrying,
		undeliverable: pending.length - retrying - awaitingRuntime,
	};
}

function widgetCountChunks(agentCount: number, queuedCount: number, counts: ReturnType<typeof widgetCounts>): string[] {
	return [
		counts.active > 0 ? `${counts.active} active` : undefined,
		agentCount - counts.active > 0 ? `${counts.open} open` : undefined,
		queuedCount > 0 ? `${counts.queued} queued` : undefined,
		counts.retrying > 0 ? `${counts.retrying} delivery retrying` : undefined,
		counts.awaitingRuntime > 0 ? `${counts.awaitingRuntime} awaiting runtime` : undefined,
		counts.undeliverable > 0 ? `${counts.undeliverable} undeliverable` : undefined,
	].filter((chunk): chunk is string => chunk != null);
}

function createDisplayRunId(
	agents: RunningSubagent[],
	queued: QueuedSubagent[],
	pending: PendingDelivery[],
	sticky: StickyTerminalRun[],
): DisplayRunId {
	const labels = buildWidgetRunIdLabels([
		...agents.map((agent) => agent.id),
		...queued.map((entry) => entry.id),
		...pending.map((entry) => entry.id),
		...sticky.map((entry) => entry.id),
	]);
	return (id) => labels.get(id) ?? sanitizeWidgetText(id).trim();
}

function buildWidgetItems(params: {
	rendered: RenderedWidgetRun[];
	queued: QueuedSubagent[];
	pending: PendingDelivery[];
	sticky: StickyTerminalRun[];
	displayRunId: DisplayRunId;
	theme: Theme;
	now: number;
}): WidgetTreeItem[] {
	const items: WidgetTreeItem[] = [];
	appendLiveWidgetItems(items, params);
	appendQueuedWidgetItems(items, params.queued, params.displayRunId);
	appendPendingWidgetItems(items, params.pending, params.displayRunId);
	appendStickyWidgetItems(items, params.sticky, params.displayRunId, params.theme);
	return items;
}

function appendLiveWidgetItems(
	items: WidgetTreeItem[],
	params: Pick<Parameters<typeof buildWidgetItems>[0], "rendered" | "displayRunId" | "theme" | "now">,
): void {
	for (const { agent, projection } of params.rendered) {
		items.push({
			identity: (available) =>
				fitIdentityContent({
					glyph: lifecycleGlyph(projection.kind, params.now),
					displayName: formatAgentDisplayName(agent.agent, agent.name),
					id: params.displayRunId(agent.id),
					admissionClass: agent.admissionClass,
					duration: formatWidgetDuration((projection.runtimeEndedAt ?? params.now) - agent.startTime),
					width: available,
				}),
			activity: (available) =>
				fitActivityContent(
					lifecycleActivityLead(agent, projection, params.now),
					agent.activity,
					params.theme,
					available,
				),
		});
	}
}

function appendQueuedWidgetItems(items: WidgetTreeItem[], queued: QueuedSubagent[], displayRunId: DisplayRunId): void {
	for (const entry of queued.slice(0, MAX_QUEUED_WIDGET_ROWS)) items.push(queuedWidgetItem(entry, displayRunId));
	if (queued.length > MAX_QUEUED_WIDGET_ROWS)
		items.push(overflowWidgetItem(`+${queued.length - MAX_QUEUED_WIDGET_ROWS} more queued`));
}

function queuedWidgetItem(entry: QueuedSubagent, displayRunId: DisplayRunId): WidgetTreeItem {
	return {
		identity: (available) =>
			truncateToWidth(
				`◷ ${formatAgentDisplayName(entry.agent, entry.name)} [${displayRunId(entry.id)}] · ${entry.admissionClass} · queued`,
				available,
			),
	};
}

function appendPendingWidgetItems(
	items: WidgetTreeItem[],
	pending: PendingDelivery[],
	displayRunId: DisplayRunId,
): void {
	for (const entry of pending) items.push(pendingWidgetItem(entry, displayRunId));
}

function pendingWidgetItem(entry: PendingDelivery, displayRunId: DisplayRunId): WidgetTreeItem {
	const details = entry.message?.details ?? {};
	const name = pendingDisplayName(details);
	const error = pendingErrorText(entry.lastError);
	const state = pendingDeliveryState(entry);
	return {
		identity: (available) =>
			truncateToWidth(`⚠ ${name} [${displayRunId(entry.id)}] · ${state}${error ? ` · ${error}` : ""}`, available),
	};
}

function pendingDisplayName(details: Record<string, unknown>): string {
	const raw =
		typeof details.name === "string"
			? details.name
			: typeof details.agent === "string"
				? details.agent
				: "subagent";
	return sanitizeWidgetText(raw).trim() || "subagent";
}

function pendingErrorText(error: string | undefined): string {
	return error ? sanitizeWidgetText(error).replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

function pendingDeliveryState(entry: PendingDelivery): string {
	if (entry.exhausted) return `undeliverable after ${entry.attempts}`;
	return entry.deferredSince !== undefined ? "awaiting runtime" : `delivery retry ${entry.attempts}`;
}

function appendStickyWidgetItems(
	items: WidgetTreeItem[],
	sticky: StickyTerminalRun[],
	displayRunId: DisplayRunId,
	theme: Theme,
): void {
	const ordered = sticky.slice().sort((left, right) => right.capturedAt - left.capturedAt);
	for (const entry of ordered.slice(0, MAX_STICKY_WIDGET_ROWS))
		items.push(stickyWidgetItem(entry, displayRunId, theme));
	if (ordered.length > MAX_STICKY_WIDGET_ROWS)
		items.push(overflowWidgetItem(`+${ordered.length - MAX_STICKY_WIDGET_ROWS} more`));
}

function stickyWidgetItem(entry: StickyTerminalRun, displayRunId: DisplayRunId, theme: Theme): WidgetTreeItem {
	const runLabel = entry.agent && entry.name !== entry.agent ? sanitizeWidgetText(entry.name).trim() : undefined;
	return {
		identity: (available) =>
			fitIdentityContent({
				glyph: stickyGlyph(entry),
				displayName: formatAgentDisplayName(entry.agent, entry.name),
				id: displayRunId(entry.id),
				admissionClass: entry.admissionClass,
				duration: formatWidgetDuration(entry.runtimeEndedAt - entry.startTime),
				width: available,
			}),
		activity: (available) => fitActivityContent(runLabel, entry.activity, theme, available),
	};
}

function stickyGlyph(entry: StickyTerminalRun): string {
	if (entry.kind === "failed") return "✗";
	return entry.kind === "stopped" ? "■" : "⚠";
}

function overflowWidgetItem(text: string): WidgetTreeItem {
	return { identity: (available) => truncateToWidth(text, available) };
}

function renderWidgetItems(items: WidgetTreeItem[], width: number): string[] {
	const lines: string[] = [];
	for (const [index, item] of items.entries()) appendWidgetItemLines(lines, item, index === items.length - 1, width);
	return lines;
}

function appendWidgetItemLines(lines: string[], item: WidgetTreeItem, last: boolean, width: number): void {
	const identityPrefix = last ? "└─ " : "├─ ";
	lines.push(fitWidgetLine(identityPrefix, item.identity(Math.max(0, width - visibleWidth(identityPrefix))), width));
	if (!item.activity) return;
	const activityPrefix = last ? "     " : "│    ";
	lines.push(fitWidgetLine(activityPrefix, item.activity(Math.max(0, width - visibleWidth(activityPrefix))), width));
}

export function renderSubagentWidget(
	theme: Theme,
	ensureLifecycle: (agent: RunningSubagent) => SubagentLifecycle,
	width: number,
): string[] {
	rememberTuiSize({ columns: width });
	return renderSubagentWidgetLines(
		Array.from(runningSubagents.values()),
		width,
		theme,
		Array.from(queuedSubagents.values()),
		Array.from(pendingDeliveries.values()),
		Array.from(stickyTerminalRuns.values()),
		ensureLifecycle,
	);
}

export function renderSubagentToolCall(args: any, theme: any) {
	const partialArgs = args as Record<string, unknown>;
	const agentId = typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "(agent required)";
	const name = typeof partialArgs.label === "string" && partialArgs.label ? partialArgs.label : agentId;
	const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
	const agent = name !== agentId ? theme.fg("dim", ` (${agentId})`) : "";
	const blockingHint = partialArgs.blocking === true ? theme.fg("dim", " [blocking]") : "";
	let text = `▸ ${theme.fg("toolTitle", theme.bold(name))}${agent}${blockingHint}`;
	if (task) {
		const firstLine = task.split("\n").find((line: string) => line.trim()) ?? "";
		const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
		if (preview) text += `\n${theme.fg("toolOutput", preview)}`;
		const totalLines = task.split("\n").length;
		if (totalLines > 1) text += theme.fg("muted", ` (${totalLines} lines)`);
	}
	return new Text(text, 0, 0);
}

export function renderSubagentToolResult(result: any, _opts: any, theme: any) {
	const details = result.details as any;
	if (details?.status === "started") return renderStartedToolResult(details, theme);
	if (details?.blocking) return renderBlockingToolResult(result, details, theme);
	return new Text(theme.fg("dim", toolResultText(result)), 0, 0);
}

function renderStartedToolResult(details: any, theme: any): Text {
	const name = details.name ?? "(unnamed)";
	const runtime = details.model
		? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
		: " — started";
	const runTag = details.id ? theme.fg("dim", ` [${details.id}]`) : "";
	return new Text(
		`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(name))}${runTag}${theme.fg("dim", runtime)}`,
		0,
		0,
	);
}

function renderBlockingToolResult(result: any, details: any, theme: any): Text {
	const presentation = blockingToolPresentation(result, details, theme);
	return new Text([presentation.header, ...toolResultPreview(result, theme)].join("\n"), 0, 0);
}

function blockingToolPresentation(result: any, details: any, theme: any): { header: string } {
	const abandoned = details.status === "abandoned";
	const failed = details.status === "error" || result.isError;
	const icon = toolResultIcon(abandoned, failed, theme);
	const status = blockingToolStatus(abandoned, failed);
	const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
	const runTag = details.id ? theme.fg("dim", ` [${details.id}]`) : "";
	return {
		header: `${subagentRowHeader(theme, icon, details.name ?? "(unnamed)", agentTag, runTag)} ${theme.fg("dim", `— ${status}`)}`,
	};
}

function toolResultIcon(abandoned: boolean, failed: boolean, theme: any): string {
	if (abandoned) return theme.fg("muted", "?");
	return failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function blockingToolStatus(abandoned: boolean, failed: boolean): string {
	if (abandoned) return "watch abandoned (outcome unknown)";
	return failed ? "failed (blocking)" : "completed (blocking)";
}

function toolResultPreview(result: any, theme: any): string[] {
	return toolResultText(result)
		.split("\n")
		.slice(0, 4)
		.map((line: string) => theme.fg("dim", line.slice(0, 120)));
}

function toolResultText(result: any): string {
	return typeof result.content[0]?.text === "string" ? result.content[0].text : "";
}

type ResultMessageDetails = {
	name?: string;
	exitCode?: number;
	errorMessage?: string;
	watchAbandoned?: boolean;
	elapsed?: number;
	agent?: string;
	id?: string;
	sessionFile?: string;
};

type ResultMessagePresentation = {
	name: string;
	exitCode: number;
	errorMessage: string;
	abandoned: boolean;
	failed: boolean;
	elapsed: string;
	background: (text: string) => string;
	header: string;
	details: ResultMessageDetails;
};

export function renderSubagentResultMessage(message: any, options: any, theme: any, width: number): string[] {
	const presentation = resultMessagePresentation(message.details as ResultMessageDetails, theme);
	const summary = resultMessageSummary(message.content, presentation);
	const lines = resultMessageLines(summary, presentation, options, theme, width);
	return renderResultMessageBox(lines, presentation.background, width);
}

function resultMessagePresentation(details: ResultMessageDetails, theme: any): ResultMessagePresentation {
	const name = details.name ?? "subagent";
	const exitCode = details.exitCode ?? 0;
	const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
	const abandoned = details.watchAbandoned === true;
	const failed = !abandoned && (exitCode !== 0 || Boolean(errorMessage));
	const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
	const icon = toolResultIcon(abandoned, failed, theme);
	const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
	const runTag = details.id ? theme.fg("dim", ` [${details.id}]`) : "";
	const status = resultMessageStatus(abandoned, failed, errorMessage, exitCode);
	return {
		name,
		exitCode,
		errorMessage,
		abandoned,
		failed,
		elapsed,
		background: resultMessageBackground(abandoned, failed, theme),
		header: `${subagentRowHeader(theme, icon, name, agentTag, runTag)} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`,
		details,
	};
}

function resultMessageStatus(abandoned: boolean, failed: boolean, errorMessage: string, exitCode: number): string {
	if (abandoned) return "watch abandoned (outcome unknown)";
	if (errorMessage) return "failed (provider/agent error)";
	return failed ? `failed (exit ${exitCode})` : "completed";
}

function resultMessageBackground(abandoned: boolean, failed: boolean, theme: any): (text: string) => string {
	if (failed) return (text) => theme.bg("toolErrorBg", text);
	return abandoned ? (text) => theme.bg("customMessageBg", text) : (text) => theme.bg("toolSuccessBg", text);
}

function resultMessageSummary(content: unknown, presentation: ResultMessagePresentation): string {
	return (typeof content === "string" ? content : "")
		.replace(/\n\nSession log: .+$/, "")
		.replace(completedResultPrefix(presentation), "")
		.replace(failedResultPrefix(presentation), "")
		.replace(providerFailurePrefix(presentation), "");
}

function completedResultPrefix(presentation: ResultMessagePresentation): string {
	return `Sub-agent "${presentation.name}"${resultRunTag(presentation.details)} completed (${presentation.elapsed}).\n\n`;
}

function failedResultPrefix(presentation: ResultMessagePresentation): string {
	return `Sub-agent "${presentation.name}"${resultRunTag(presentation.details)} failed (exit code ${presentation.exitCode}).\n\n`;
}

function resultRunTag(details: ResultMessageDetails): string {
	return details.id ? ` [${details.id}]` : "";
}

function providerFailurePrefix(presentation: ResultMessagePresentation): RegExp {
	const name = escapeRegExp(presentation.name);
	const id = presentation.details.id ? ` \\[${escapeRegExp(String(presentation.details.id))}\\]` : "";
	return new RegExp(
		`^Sub-agent "${name}"${id} failed after ${presentation.elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resultMessageLines(
	summary: string,
	presentation: ResultMessagePresentation,
	options: any,
	theme: any,
	width: number,
): string[] {
	const lines = [presentation.header];
	if (options.expanded) appendExpandedResultLines(lines, summary, presentation.details, theme, width);
	else appendCollapsedResultLines(lines, summary, theme, width);
	return lines;
}

function appendExpandedResultLines(
	lines: string[],
	summary: string,
	details: ResultMessageDetails,
	theme: any,
	width: number,
): void {
	for (const line of summaryLines(summary, width)) lines.push(line);
	if (!details.sessionFile) return;
	lines.push("", theme.fg("dim", `Session log: ${details.sessionFile}`));
}

function appendCollapsedResultLines(lines: string[], summary: string, theme: any, width: number): void {
	const preview = summaryLines(summary, width).slice(0, 5);
	for (const line of preview) lines.push(theme.fg("dim", line));
	const omitted = summary.split("\n").length - preview.length;
	if (summary && omitted > 0) lines.push(theme.fg("muted", `… ${omitted} more lines`));
	lines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
}

function summaryLines(summary: string, width: number): string[] {
	return summary ? summary.split("\n").map((line) => line.slice(0, width - 6)) : [];
}

function renderResultMessageBox(lines: string[], background: (text: string) => string, width: number): string[] {
	const box = new Box(1, 1, background);
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return ["", ...box.render(width)];
}

export function renderSubagentStatusMessage(
	lines: string[],
	overflow: number,
	options: any,
	theme: any,
	width: number,
): string[] {
	const lineWidth = Math.max(0, width - 6);
	const contentLines = [
		`${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
		...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
	];
	if (overflow > 0) contentLines.push(theme.fg("muted", `+${overflow} more running.`));
	if (!options.expanded) contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
	const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
	box.addChild(new Text(contentLines.join("\n"), 0, 0));
	return ["", ...box.render(width)];
}
