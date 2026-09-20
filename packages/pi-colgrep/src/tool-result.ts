/**
 * Helpers to create AgentToolResult-compatible objects.
 *
 * Pi's AgentToolResult expects `content` as an array of TextContent objects
 * and a `details` field. These helpers wrap a plain string into that shape.
 */

interface ToolResult<TDetails = undefined> {
  content: { type: "text"; text: string }[];
  details: TDetails;
  isError: boolean;
}

export function ok<TDetails = undefined>(
  text: string,
  details?: TDetails,
): ToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details: details as TDetails,
    isError: false,
  };
}

export function err(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    isError: true,
  };
}
