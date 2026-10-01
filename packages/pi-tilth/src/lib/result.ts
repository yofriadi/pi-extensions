/**
 * Conversion of MCP `CallToolResult` payloads to tool text.
 *
 * The native-mcp-transport contract:
 *  - All `TextContent` blocks are joined into a single string.
 *  - `isError: true` maps to `ServerToolError` carrying the server's text
 *    verbatim (pi marks a tool result as an error only when `execute()`
 *    throws).
 *  - A result with no text blocks is an unknown output shape and throws
 *    `TransportError`.
 *
 * Transport/process failures (connection loss, non-zero exit, spawn error)
 * are wrapped into `TransportError` with the attempt's captured stderr by
 * `TilthMcpTransport`, not here.
 */
import type { CallToolResult } from "@earendil-works/pi-mcp";

export class TransportError extends Error {}
export class ServerToolError extends Error {}

function joinTextBlocks(content: CallToolResult["content"]): string | undefined {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		}
	}
	// A result with no text blocks is an unknown shape, not empty output.
	return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * Convert one `CallToolResult` to its text form.
 *
 * Throws `ServerToolError` when the result reports `isError: true` (message
 * carries the server's own text), and `TransportError` when the result has
 * no text content blocks at all.
 */
export function callToolResultToText(result: CallToolResult): string {
	const text = joinTextBlocks(result.content);
	if (result.isError === true) {
		throw new ServerToolError(text ?? "tilth reported an error with no text content");
	}
	if (text === undefined) {
		throw new TransportError("tilth tool result has no text content blocks — unknown output shape");
	}
	return text;
}
