import type {
	Context,
	ImageContent,
	Message as PiMessage,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai";

/** OpenAI-ish message shapes the Perch chat lane accepts. */
export interface PerchMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: PerchToolCall[];
	tool_call_id?: string;
}

export interface PerchToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface PerchTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ConvertedMessages {
	messages: PerchMessage[];
	tools?: PerchTool[];
	toolChoice?: "auto";
}

/** Content parts that can carry visible text. */
type UserishPart = TextContent | ImageContent;

function partsToText(parts: UserishPart[]): string {
	return parts
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

function userContentToString(content: string | UserishPart[]): string {
	return typeof content === "string" ? content : partsToText(content);
}

function toolCallArguments(call: ToolCall): string {
	try {
		return JSON.stringify(call.arguments);
	} catch {
		return "{}";
	}
}

function assistantParts(content: (TextContent | ThinkingContent | ToolCall)[]): {
	text: string | null;
	toolCalls: PerchToolCall[] | null;
} {
	const texts: string[] = [];
	const toolCalls: PerchToolCall[] = [];
	// ThinkingContent parts are dropped: Perch has no channel for prior reasoning.
	for (const part of content) {
		if (part.type === "text") {
			texts.push(part.text);
		} else if (part.type === "toolCall") {
			toolCalls.push({
				id: part.id,
				type: "function",
				function: {
					name: part.name,
					arguments: toolCallArguments(part),
				},
			});
		}
	}
	return {
		text: texts.length > 0 ? texts.join("") : null,
		toolCalls: toolCalls.length > 0 ? toolCalls : null,
	};
}

/** Converts pi's context (system prompt, messages, tools) to the Perch chat shape. */
export function convertContext(context: Context): ConvertedMessages {
	const out: PerchMessage[] = [];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		out.push({ role: "system", content: context.systemPrompt });
	}
	for (const message of context.messages as PiMessage[]) {
		if (message.role === "user") {
			out.push({ role: "user", content: userContentToString(message.content) });
		} else if (message.role === "assistant") {
			const { text, toolCalls } = assistantParts(message.content);
			if (text !== null || toolCalls !== null) {
				out.push({
					role: "assistant",
					content: text,
					...(toolCalls !== null ? { tool_calls: toolCalls } : {}),
				});
			}
		} else if (message.role === "toolResult") {
			out.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				content: userContentToString(message.content),
			});
		}
	}
	const tools = context.tools ? convertTools(context.tools) : [];
	return {
		messages: out,
		tools: tools.length > 0 ? tools : undefined,
		toolChoice: tools.length > 0 ? "auto" : undefined,
	};
}

/** pi Tool array → OpenAI function form; parameters default to an empty object schema. */
export function convertTools(tools: Tool[]): PerchTool[] {
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: (tool.parameters as Record<string, unknown> | undefined) ?? {
				type: "object",
				properties: {},
			},
		},
	}));
}
