/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { createSubagentActivityRecorder } from "./activity.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
	return agentStarted;
}

export function shouldAutoExitOnAgentEnd(_userTookOver: boolean, messages: any[] | undefined): boolean {
	// Manual input should not strand an auto-exit subagent. If the latest agent
	// turn completed normally, close the session.
	//
	// Pi reports Escape as stopReason "aborted" or the exact terminal message
	// "This operation was aborted.". Other error text, even if it mentions an
	// aborted request, is a provider/transport failure and must settle via .exit.
	if (messages) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role === "assistant") {
				return msg.stopReason !== "aborted" && msg.stopReason !== "error";
			}
		}
	}

	return true;
}

export function didLatestAssistantAbort(messages: any[] | undefined): boolean {
	if (!messages) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason === "aborted") return true;
		const errorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
		return msg.stopReason === "error" && /^This operation was aborted\.?$/.test(errorMessage.trim());
	}
	return false;
}

export interface SubagentErrorInfo {
	errorMessage: string;
	stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(messages: any[] | undefined): SubagentErrorInfo | null {
	if (!messages) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason !== "error") return null;
		const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
		return {
			errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
			stopReason: "error",
		};
	}
	return null;
}

export function buildCompletionSidecar(
	messages: any[] | undefined,
): { type: "done"; runId?: string } | { type: "error"; errorMessage: string; stopReason: "error"; runId?: string } {
	const errorInfo = findLatestAssistantError(messages);
	const runId = process.env.PI_SUBAGENT_ID;
	return errorInfo
		? { type: "error", ...errorInfo, ...(runId ? { runId } : {}) }
		: { type: "done", ...(runId ? { runId } : {}) };
}

function writeCompletionSidecar(sessionFile: string, payload: object): void {
	const exitFile = `${sessionFile}.exit`;
	const temporary = `${exitFile}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, exitFile);
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
	return (rawValue ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

export interface SelectedSkillMetadata {
	name: string;
	description: string;
	filePath: string;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function parseSelectedSkillMetadata(raw: string | undefined): SelectedSkillMetadata[] {
	if (!raw) return [];
	const value = JSON.parse(raw) as unknown;
	if (!Array.isArray(value)) throw new Error("Invalid selected skill metadata.");
	return value.map(parseSelectedSkillMetadataEntry);
}

function parseSelectedSkillMetadataEntry(entry: unknown): SelectedSkillMetadata {
	const record = skillMetadataRecord(entry);
	return {
		name: requiredSkillMetadataField(record, "name"),
		description: requiredSkillMetadataField(record, "description"),
		filePath: requiredSkillMetadataField(record, "filePath"),
	};
}

function skillMetadataRecord(entry: unknown): Record<string, unknown> {
	if (!entry || typeof entry !== "object") throw new Error("Invalid selected skill metadata.");
	return entry as Record<string, unknown>;
}

function requiredSkillMetadataField(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== "string") throw new Error("Invalid selected skill metadata.");
	return value;
}

export function assertSelectedSkillCompanionOrdering(
	selectedSkillCount: number,
	companionOrder: string | undefined,
): void {
	if (selectedSkillCount > 0 && companionOrder !== "explicit-before-discovered") {
		throw new Error("Cannot guarantee selected-skill prompt ordering.");
	}
}

export function injectSelectedSkillMetadata(systemPrompt: string, skills: SelectedSkillMetadata[]): string {
	if (skills.length === 0) return systemPrompt;
	const containers = systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/g) ?? [];
	if (containers.length > 1) {
		throw new Error("Cannot guarantee selected-skill prompt ordering: multiple available_skills containers.");
	}
	const entries = skills
		.map((skill) =>
			[
				"  <skill>",
				`    <name>${escapeXml(skill.name)}</name>`,
				`    <description>${escapeXml(skill.description)}</description>`,
				`    <location>${escapeXml(skill.filePath)}</location>`,
				"  </skill>",
			].join("\n"),
		)
		.join("\n");
	const container = `<available_skills>\n${entries}\n</available_skills>`;
	if (containers.length === 1) return systemPrompt.replace(containers[0], container);
	return `${systemPrompt.trimEnd()}\n\n${container}`;
}

type SubagentWidgetData = {
	subagentName: string;
	subagentAgent: string;
	toolNames: string[];
	denied: string[];
	expanded: boolean;
};

function renderSubagentWidgetBox(theme: any, data: SubagentWidgetData): Box {
	const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));
	const content = data.expanded ? expandedWidgetContent(theme, data) : collapsedWidgetContent(theme, data);
	box.addChild(new Text(content, 0, 0));
	return box;
}

function expandedWidgetContent(theme: any, data: SubagentWidgetData): string {
	const countInfo = theme.fg("dim", ` — ${data.toolNames.length} available`);
	const hint = theme.fg("muted", "  (Ctrl+J to collapse)");
	const toolList = joinWidgetNames(theme, data.toolNames, "dim");
	return `${widgetAgentTag(theme, data)}${countInfo}${hint}\n${toolList}${deniedWidgetLine(theme, data.denied)}`;
}

function collapsedWidgetContent(theme: any, data: SubagentWidgetData): string {
	const countInfo = theme.fg("dim", ` — ${data.toolNames.length} tools`);
	const hint = theme.fg("muted", "  (Ctrl+J to expand)");
	return `${widgetAgentTag(theme, data)}${countInfo}${collapsedDeniedInfo(theme, data.denied)}${hint}`;
}

function widgetAgentTag(theme: any, data: SubagentWidgetData): string {
	const label = data.subagentAgent || data.subagentName;
	return label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";
}

function joinWidgetNames(theme: any, names: string[], color: string): string {
	return names.map((name) => theme.fg(color, name)).join(theme.fg("muted", ", "));
}

function deniedWidgetLine(theme: any, denied: string[]): string {
	if (denied.length === 0) return "";
	return `\n${theme.fg("muted", "denied: ")}${joinWidgetNames(theme, denied, "error")}`;
}

function collapsedDeniedInfo(theme: any, denied: string[]): string {
	return denied.length > 0 ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`) : "";
}
export default function (pi: ExtensionAPI) {
	let toolNames: string[] = [];
	let denied: string[] = [];
	let expanded = false;

	// Read subagent identity from env vars (set by parent orchestrator)
	const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
	const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
	const deniedToolsValue = process.env.PI_DENY_TOOLS;
	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
	const selectedSkills = parseSelectedSkillMetadata(process.env.PI_SUBAGENT_SELECTED_SKILLS);
	assertSelectedSkillCompanionOrdering(selectedSkills.length, process.env.PI_SUBAGENT_COMPANION_ORDER);
	const recorder = createSubagentActivityRecorder({
		runningChildId: process.env.PI_SUBAGENT_ID,
		activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
	});

	function sampleContextUsage(ctx: Pick<ExtensionContext, "getContextUsage">): void {
		const usage = ctx.getContextUsage();
		if (!usage) return;
		recorder.contextUsage(usage.tokens, usage.contextWindow, usage.percent);
	}

	function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
		ctx.ui.setWidget(
			"subagent-tools",
			(_tui: any, theme: any) =>
				renderSubagentWidgetBox(theme, { subagentName, subagentAgent, toolNames, denied, expanded }),
			{ placement: "aboveEditor" },
		);
	}

	let userTookOver = false;
	let agentStarted = false;

	// Show widget + status bar on session start
	pi.on("session_start", (_event, ctx) => {
		recorder.sessionStart();
		const tools = pi.getAllTools();
		toolNames = tools.map((t) => t.name).sort();
		denied = parseDeniedTools(deniedToolsValue);

		renderWidget(ctx, null);
	});

	pi.on("input", () => {
		recorder.input();
		// Ignore the initial task message that starts an autonomous subagent.
		// Only inputs after the first agent run has started count as user takeover.
		if (!shouldMarkUserTookOver(agentStarted)) return;
		userTookOver = true;
	});

	pi.on("before_agent_start", (event) => {
		recorder.beforeAgentStart();
		if (selectedSkills.length === 0) return;
		return {
			systemPrompt: injectSelectedSkillMetadata((event as any).systemPrompt, selectedSkills),
		};
	});

	const writeInspection = (ctx: any) => {
		const inspectionDir = process.env.PI_SUBAGENT_INSPECTION_DIR;
		const runId = process.env.PI_SUBAGENT_ID;
		if (!inspectionDir || !runId) return;
		mkdirSync(inspectionDir, { recursive: true });
		const path = `${inspectionDir}/${runId}.json`;
		writeFileSync(
			path,
			`${JSON.stringify({
				runId,
				agent: process.env.PI_SUBAGENT_AGENT,
				activeTools: pi.getActiveTools().slice().sort(),
				systemPrompt: ctx.getSystemPrompt(),
			})}\n`,
			{ mode: 0o600 },
		);
		chmodSync(path, 0o600);
	};

	pi.on("agent_start", (_event, ctx) => {
		agentStarted = true;
		recorder.agentStart();
		writeInspection(ctx);
	});

	// The exit/sidecar decision is deferred to agent_settled: pi emits the raw
	// agent_end BEFORE deciding whether a stopReason:"error" turn is retryable,
	// so acting here would publish transient mid-backoff errors as terminal
	// failures and shut the child down during its own retry.
	let pendingAgentEndMessages: any[] | undefined;
	pi.on("agent_end", (event, _ctx) => {
		pendingAgentEndMessages = (event as any).messages as any[] | undefined;
	});

	function settleAgentRun(ctx: any): void {
		const messages = pendingAgentEndMessages;
		pendingAgentEndMessages = undefined;
		const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);
		const interrupted = didLatestAssistantAbort(messages);
		publishSettledSidecar(messages, shouldExit, interrupted);
		if (shouldExit) {
			recorder.agentEndDone();
			ctx.shutdown();
			return;
		}
		if (interrupted) recorder.agentEndInterrupted();
		else recorder.agentEndWaiting();
		if (autoExit) userTookOver = false;
	}

	function publishSettledSidecar(messages: any[] | undefined, shouldExit: boolean, interrupted: boolean): void {
		const sessionFile = sidecarSessionFile(messages, shouldExit, interrupted);
		if (!sessionFile) return;
		writeCompletionSidecarBestEffort(sessionFile, messages);
	}

	function sidecarSessionFile(
		messages: any[] | undefined,
		shouldExit: boolean,
		interrupted: boolean,
	): string | undefined {
		if (interrupted) return undefined;
		const sessionFile = process.env.PI_SUBAGENT_SESSION;
		if (!sessionFile) return undefined;
		return shouldExit || findLatestAssistantError(messages) ? sessionFile : undefined;
	}

	function writeCompletionSidecarBestEffort(sessionFile: string, messages: any[] | undefined): void {
		try {
			writeCompletionSidecar(sessionFile, buildCompletionSidecar(messages));
		} catch {
			// Best effort — the watcher can still detect the terminal sentinel after shutdown.
		}
	}

	pi.on("agent_settled", (_event, ctx) => settleAgentRun(ctx));

	pi.on("turn_start", (event) => {
		recorder.turnStart((event as any).turnIndex);
	});

	pi.on("turn_end", (event, ctx) => {
		recorder.turnEnd((event as any).turnIndex);
		sampleContextUsage(ctx);
	});

	pi.on("before_provider_request", () => {
		recorder.beforeProviderRequest();
	});

	pi.on("after_provider_response", (_event, ctx) => {
		recorder.afterProviderResponse();
		sampleContextUsage(ctx);
	});

	pi.on("message_update", (event) => {
		recorder.messageUpdate((event as any).assistantMessageEvent?.type);
	});

	pi.on("tool_execution_start", (event) => {
		recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
	});

	pi.on("tool_call", (event) => {
		recorder.toolCall((event as any).toolCallId, (event as any).toolName);
	});

	pi.on("tool_execution_update", (event) => {
		recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
	});

	pi.on("tool_result", (event) => {
		recorder.toolResult((event as any).toolCallId, (event as any).toolName);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
		sampleContextUsage(ctx);
	});

	pi.on("session_compact", () => {
		recorder.compaction();
	});

	pi.on("session_shutdown", (event) => {
		recorder.sessionShutdown((event as any).reason);
	});

	// Toggle expand/collapse with Ctrl+J
	pi.registerShortcut("ctrl+j", {
		description: "Toggle subagent tools widget",
		handler: (ctx) => {
			expanded = !expanded;
			renderWidget(ctx, null);
		},
	});

	pi.registerTool({
		name: "subagent_done",
		label: "Subagent Done",
		description:
			"Call this tool when you have completed your task. " +
			"It will close this session and return your results to the main session. " +
			"Your LAST assistant message before calling this becomes the summary returned to the caller.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const sessionFile = process.env.PI_SUBAGENT_SESSION;
			recorder.subagentDone();
			if (sessionFile) {
				writeCompletionSidecar(sessionFile, { type: "done", runId: process.env.PI_SUBAGENT_ID });
			}
			ctx.shutdown();
			return {
				content: [{ type: "text", text: "Shutting down subagent session." }],
				details: {},
			};
		},
	});
}
