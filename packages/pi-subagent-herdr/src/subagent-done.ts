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
	// stopReason "aborted" (Escape) and "error" (provider failure, exhausted
	// retries) keep the pane OPEN: an unexpectedly dead worker must remain
	// visible so the user can see something broke and inspect the session. The
	// error sidecar is still written by the agent_end handler so the parent
	// learns it was an error, not a clean completion.
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
	return value.map((entry) => {
		if (
			entry == null ||
			typeof entry !== "object" ||
			typeof (entry as any).name !== "string" ||
			typeof (entry as any).description !== "string" ||
			typeof (entry as any).filePath !== "string"
		) {
			throw new Error("Invalid selected skill metadata.");
		}
		return {
			name: (entry as any).name,
			description: (entry as any).description,
			filePath: (entry as any).filePath,
		};
	});
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
			(_tui: any, theme: any) => {
				const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

				const label = subagentAgent || subagentName;
				const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

				if (expanded) {
					// Expanded: full tool list + denied
					const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
					const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

					const toolList = toolNames
						.map((name: string) => theme.fg("dim", name))
						.join(theme.fg("muted", ", "));

					let deniedLine = "";
					if (denied.length > 0) {
						const deniedList = denied
							.map((name: string) => theme.fg("error", name))
							.join(theme.fg("muted", ", "));
						deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
					}

					const content = new Text(`${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`, 0, 0);
					box.addChild(content);
				} else {
					// Collapsed: one-line summary
					const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
					const deniedInfo =
						denied.length > 0 ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`) : "";
					const hint = theme.fg("muted", "  (Ctrl+J to expand)");

					const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
					box.addChild(content);
				}

				return box;
			},
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

	pi.on("agent_settled", (_event, ctx) => {
		const messages = pendingAgentEndMessages;
		pendingAgentEndMessages = undefined;
		const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);

		// Surface terminal stopReason: "error" turns (auto-retry exhausted,
		// provider overload, etc.) to the parent via the .exit sidecar so the
		// watcher can report a clear failure with the underlying error message.
		// Written even when the pane stays open — errors no longer auto-exit, and
		// without the sidecar the parent would only see a stale assistant message,
		// mistaking the crash for a still-running worker. Only settled (final)
		// errors reach this point; transient retryable errors never publish.
		const sessionFile = process.env.PI_SUBAGENT_SESSION;
		if (sessionFile && (shouldExit || findLatestAssistantError(messages))) {
			try {
				writeCompletionSidecar(sessionFile, buildCompletionSidecar(messages));
			} catch {
				// Best effort — the watcher can still detect the terminal sentinel
				// after shutdown if the completion sidecar cannot be written.
			}
		}

		if (shouldExit) {
			recorder.agentEndDone();
			ctx.shutdown();
			return;
		}

		recorder.agentEndWaiting();
		if (autoExit) {
			// Reset any recorded manual input marker. Auto-exit is decided by whether
			// the latest agent turn completed normally, not by who initiated it.
			userTookOver = false;
		}
	});

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
		name: "caller_ping",
		label: "Caller Ping",
		description:
			"Send a help request to the parent agent and exit this session. " +
			"The parent will be notified with your message and can resume this session with a response. " +
			"Use when you're stuck, need clarification, or need the parent to take action.",
		parameters: Type.Object({
			message: Type.String({ description: "What you need help with" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = process.env.PI_SUBAGENT_SESSION;
			if (!sessionFile) {
				throw new Error(
					"caller_ping is only available in subagent contexts. " +
						"PI_SUBAGENT_SESSION environment variable is not set.",
				);
			}

			recorder.callerPing();
			const exitData = {
				type: "ping" as const,
				name: process.env.PI_SUBAGENT_NAME ?? "subagent",
				message: params.message,
				runId: process.env.PI_SUBAGENT_ID,
			};
			writeCompletionSidecar(sessionFile, exitData);

			ctx.shutdown();
			return {
				content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
				details: {},
			};
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
