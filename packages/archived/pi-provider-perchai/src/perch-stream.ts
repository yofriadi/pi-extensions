import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describePerchError, PerchError } from "./errors.ts";

/** SSE event shapes emitted by the Perch model-call endpoint. */
export interface PerchStreamEvent {
	type?: string;
	/** reasoning_delta / answer_delta */
	text?: string;
	/** tool_call_delta / tool_use_end */
	toolCalls?: { id?: string; name?: string; rawArgumentsText?: string; arguments?: unknown }[];
	/** model_call_failed */
	error?: unknown;
	errorCode?: string;
	/** done */
	ok?: boolean;
	provider?: string;
	model?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheWriteInputTokens?: number;
	};
	durationMs?: number;
	/** error */
	message?: string;
}

/** Tool-call accumulator state across `tool_call_delta` → `tool_use_end`. */
interface ToolCallState {
	id: string;
	name: string;
	/** contentIndex assigned at toolcall_start; reused for delta/end. */
	contentIndex: number;
	streamedArguments: string;
	/** Sealed arguments from tool_use_end (object form). */
	sealedArguments: Record<string, unknown> | null;
	/** Sealed arguments from tool_use_end (raw string form). */
	sealedRaw: string | null;
	/** True once toolcall_end has been emitted for this index. */
	sealed: boolean;
}

/** The currently-open text/thinking block (at most one at a time). */
interface OpenBlock {
	kind: "text" | "thinking";
	contentIndex: number;
}

function zeroCostUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function usageFromPerch(usage: PerchStreamEvent["usage"]): Usage {
	const result = zeroCostUsage();
	if (usage) {
		result.input = usage.inputTokens ?? 0;
		result.output = usage.outputTokens ?? 0;
		result.cacheRead = usage.cacheReadInputTokens ?? 0;
		result.cacheWrite = usage.cacheWriteInputTokens ?? 0;
		result.totalTokens = result.input + result.output + result.cacheRead + result.cacheWrite;
	}
	return result;
}

function parseArgumentsRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		if (value.trim().length === 0) {
			return {};
		}
		try {
			const parsed = JSON.parse(value) as unknown;
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

/** Arguments for the final toolCall: sealed text wins, else streamed text. */
function finalArguments(state: ToolCallState): Record<string, unknown> {
	if (state.sealedArguments !== null) {
		return state.sealedArguments;
	}
	const raw = state.sealedRaw ?? state.streamedArguments;
	const parsed = parseArgumentsRecord(raw);
	return parsed ?? {};
}

/**
 * Translates a Perch SSE body into pi AssistantMessageEvents.
 *
 * Follows the pi stream contract: `start` first; a mutable placeholder block
 * is inserted into `partial.content` before each `*_start`; deltas mutate that
 * block in place; `*_end` finalizes the same index exactly once. Tool calls
 * reserve their index at `toolcall_start` and finalize the same index at
 * `toolcall_end`, so out-of-order sealing stays consistent.
 *
 * Terminal conditions (all stop further processing):
 * - `done {ok:true}` → usage + stopReason (toolUse when tool calls sealed).
 * - `done` without `ok:true` / `error` → mapped failure.
 * - body ends without a terminal event → failure, never an empty success.
 * - abort → error event with stopReason "aborted".
 */
export function translatePerchStream(
	body: ReadableStream<Uint8Array>,
	model: Model<string>,
	signal: AbortSignal,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroCostUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const toolCalls = new Map<string, ToolCallState>();
	let openBlock: OpenBlock | null = null;
	let sealedToolCallCount = 0;
	let started = false;
	let terminated = false;
	let latestModelCallFailure: PerchError | null = null;

	function pushStart(): void {
		if (started) {
			return;
		}
		started = true;
		stream.push({ type: "start", partial: message });
	}

	/** Opens a text/thinking block: inserts the placeholder, then emits *_start. */
	function openContentBlock(kind: "text" | "thinking"): OpenBlock {
		if (openBlock !== null && openBlock.kind === kind) {
			return openBlock;
		}
		closeBlock();
		pushStart();
		const contentIndex = message.content.length;
		if (kind === "text") {
			const content: TextContent = { type: "text", text: "" };
			message.content.push(content);
			stream.push({ type: "text_start", contentIndex, partial: message });
		} else {
			const content: ThinkingContent = { type: "thinking", thinking: "" };
			message.content.push(content);
			stream.push({ type: "thinking_start", contentIndex, partial: message });
		}
		openBlock = { kind, contentIndex };
		return openBlock;
	}

	/** Finalizes the open block (emits *_end) if one is open. */
	function closeBlock(): void {
		if (openBlock === null) {
			return;
		}
		const { kind, contentIndex } = openBlock;
		const content = message.content[contentIndex];
		if (kind === "text") {
			const text = content?.type === "text" ? content.text : "";
			stream.push({ type: "text_end", contentIndex, content: text, partial: message });
		} else {
			const thinking = content?.type === "thinking" ? content.thinking : "";
			stream.push({ type: "thinking_end", contentIndex, content: thinking, partial: message });
		}
		openBlock = null;
	}

	function appendToOpenBlock(delta: string): void {
		if (openBlock === null) {
			return;
		}
		const content = message.content[openBlock.contentIndex];
		if (openBlock.kind === "text" && content?.type === "text") {
			content.text += delta;
			stream.push({ type: "text_delta", contentIndex: openBlock.contentIndex, delta, partial: message });
		} else if (openBlock.kind === "thinking" && content?.type === "thinking") {
			content.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: openBlock.contentIndex, delta, partial: message });
		}
	}

	function getOrCreateToolCall(id: string, name: string): ToolCallState {
		const existing = toolCalls.get(id);
		if (existing) {
			return existing;
		}
		// Close any open text/thinking block so the tool call lands after it in
		// message.content (content order matches the wire).
		closeBlock();
		pushStart();
		const contentIndex = message.content.length;
		const placeholder: ToolCall = { type: "toolCall", id, name, arguments: {} };
		message.content.push(placeholder);
		const state: ToolCallState = {
			id,
			name,
			contentIndex,
			streamedArguments: "",
			sealedArguments: null,
			sealedRaw: null,
			sealed: false,
		};
		toolCalls.set(id, state);
		stream.push({ type: "toolcall_start", contentIndex, partial: message });
		return state;
	}

	function sealToolCall(state: ToolCallState): void {
		if (state.sealed) {
			return;
		}
		state.sealed = true;
		const args = finalArguments(state);
		const toolCall: ToolCall = { type: "toolCall", id: state.id, name: state.name, arguments: args };
		message.content[state.contentIndex] = toolCall;
		sealedToolCallCount++;
		stream.push({ type: "toolcall_end", contentIndex: state.contentIndex, toolCall, partial: message });
	}

	/** Discards every artifact from the failed route before replay begins. */
	function resetAccumulators(): void {
		openBlock = null;
		message.content.splice(0, message.content.length);
		toolCalls.clear();
		sealedToolCallCount = 0;
		latestModelCallFailure = null;
	}

	function markRecovered(): void {
		latestModelCallFailure = null;
	}

	function handleEvent(event: PerchStreamEvent): void {
		if (terminated) {
			return;
		}
		switch (event.type) {
			case "answer_delta": {
				if (typeof event.text === "string" && event.text.length > 0) {
					markRecovered();
					openContentBlock("text");
					appendToOpenBlock(event.text);
				}
				break;
			}
			case "reasoning_delta": {
				if (typeof event.text === "string" && event.text.length > 0) {
					markRecovered();
					openContentBlock("thinking");
					appendToOpenBlock(event.text);
				}
				break;
			}
			case "tool_call_delta": {
				for (const call of event.toolCalls ?? []) {
					markRecovered();
					if (typeof call.id !== "string" || call.id.length === 0) {
						continue;
					}
					const state = getOrCreateToolCall(call.id, typeof call.name === "string" ? call.name : "tool");
					if (typeof call.rawArgumentsText === "string" && call.rawArgumentsText.length > 0) {
						state.streamedArguments += call.rawArgumentsText;
						stream.push({
							type: "toolcall_delta",
							contentIndex: state.contentIndex,
							delta: call.rawArgumentsText,
							partial: message,
						});
					}
				}
				break;
			}
			case "tool_use_end": {
				for (const call of event.toolCalls ?? []) {
					markRecovered();
					if (typeof call.id !== "string" || call.id.length === 0) {
						continue;
					}
					const state = getOrCreateToolCall(call.id, typeof call.name === "string" ? call.name : "tool");
					if (call.arguments !== undefined) {
						const sealed = parseArgumentsRecord(call.arguments);
						if (sealed !== null) {
							state.sealedArguments = sealed;
						} else if (typeof call.arguments === "string") {
							state.sealedRaw = call.arguments;
						}
					}
					sealToolCall(state);
				}
				break;
			}
			case "stream_restart": {
				resetAccumulators();
				break;
			}
			case "continuation_seam": {
				break;
			}
			case "model_call_failed": {
				// The auto-router can recover in-stream. Retain the latest envelope
				// only for EOF; any subsequent content or restart proves recovery.
				const rawBody = JSON.stringify(event);
				const parsed = describePerchError(0, rawBody);
				latestModelCallFailure = new PerchError({
					message: parsed.message,
					errorCode: parsed.errorCode,
					rawBody: parsed.rawBody,
					bodyText: typeof event.error === "string" ? event.error : rawBody,
				});
				break;
			}
			case "done": {
				terminated = true;
				if (event.ok === true) {
					markRecovered();
					closeBlock();
					pushStart();
					message.usage = usageFromPerch(event.usage);
					message.responseModel =
						typeof event.model === "string" && event.model.length > 0 ? event.model : model.id;
					message.stopReason = sealedToolCallCount > 0 ? "toolUse" : "stop";
					stream.push({ type: "done", reason: message.stopReason, message });
					stream.end(message);
				} else {
					// done without ok:true carries the same envelope as an HTTP error
					// body; reuse describePerchError so guidance matches (no HTTP status).
					const parsed = describePerchError(0, JSON.stringify(event));
					finishWithError(
						"error",
						new PerchError({
							message: parsed.message,
							errorCode: parsed.errorCode,
							rawBody: parsed.rawBody,
						}),
					);
				}
				return;
			}
			case "error": {
				terminated = true;
				finishWithError(
					"error",
					new PerchError({
						message: typeof event.message === "string" ? event.message : "perch: stream error",
					}),
				);
				return;
			}
		}
	}

	function finishWithError(reason: "error", error: PerchError): void {
		pushStart();
		message.stopReason = "error";
		message.errorMessage = error.message;
		stream.push({ type: "error", reason, error: message });
		stream.end(message);
	}

	function finishAborted(): void {
		pushStart();
		message.stopReason = "aborted";
		message.errorMessage = "perch: request aborted";
		stream.push({ type: "error", reason: "aborted", error: message });
		stream.end(message);
	}

	void (async () => {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const onAbort = () => {
			void reader.cancel().catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const processLine = (line: string): void => {
			if (!line.startsWith("data:")) {
				return;
			}
			const payload = line.slice(5).trim();
			if (payload.length === 0 || payload === "[DONE]") {
				return;
			}
			try {
				handleEvent(JSON.parse(payload) as PerchStreamEvent);
			} catch {
				// Malformed JSON lines are tolerated.
			}
		};
		try {
			while (true) {
				if (signal.aborted || terminated) {
					break;
				}
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				let newlineIndex = buffer.indexOf("\n");
				while (newlineIndex !== -1) {
					const line = buffer.slice(0, newlineIndex);
					buffer = buffer.slice(newlineIndex + 1);
					newlineIndex = buffer.indexOf("\n");
					processLine(line);
					if (terminated) {
						break;
					}
				}
				if (terminated) {
					break;
				}
			}
			// Flush the decoder and any non-newline-terminated tail line.
			if (!terminated) {
				buffer += decoder.decode();
				if (buffer.length > 0) {
					processLine(buffer);
					buffer = "";
				}
			}
			if (terminated) {
				return;
			}
			if (signal.aborted) {
				finishAborted();
				return;
			}
			// Body ended without a terminal event. Preserve the server's latest
			// model_call_failed envelope when routing never recovered.
			finishWithError(
				"error",
				latestModelCallFailure ?? new PerchError({ message: "perch: stream ended without done{ok:true}" }),
			);
		} catch (error) {
			if (terminated) {
				return;
			}
			if (signal.aborted) {
				finishAborted();
				return;
			}
			finishWithError("error", error instanceof PerchError ? error : new PerchError({ message: String(error) }));
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	})();

	return stream;
}
