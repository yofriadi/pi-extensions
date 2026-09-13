/**
 * Parsing of the mcporter JSON call envelope.
 *
 * The envelope shape (verified live against mcporter 0.13.10 + tilth):
 *   { "content": [{ "type": "text", "text": "..." }, ...], "isError": bool }
 *
 * Narrow parsing: join the text blocks, map isError to a server-message
 * error, surface malformed JSON / killed processes / non-zero exits with
 * mcporter's stderr verbatim. Content is never fabricated, summarized, or
 * retried here.
 */

export interface McporterEnvelope {
	isError: boolean;
	/** Joined text of all text content blocks. */
	text: string;
}

export class TransportError extends Error {}
export class ServerToolError extends Error {}

interface RawEnvelope {
	content?: unknown;
	isError?: unknown;
}

function joinTextBlocks(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as Record<string, unknown>).type === "text" &&
			typeof (block as Record<string, unknown>).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	// An array with no text blocks is an unknown shape, not empty output.
	return parts.length === 0 ? undefined : parts.join("\n");
}

export interface McporterProcessResult {
	stdout: string;
	stderr: string;
	code: number;
	/**
	 * True when the exec seam terminated the process (call timeout or abort).
	 * pi's exec resolves `code ?? 0` for signal-deaths, so a complete JSON
	 * envelope on stdout of a killed process must NOT be trusted as success.
	 */
	killed: boolean;
}

/**
 * Parse raw mcporter output into a normalized envelope.
 *
 * Throws TransportError when the process was killed by the call timeout or an
 * abort (message names the cause and carries mcporter's stderr verbatim),
 * when it exited non-zero, or when the output is not a parseable envelope
 * (message carries mcporter's stderr verbatim). Throws ServerToolError when
 * the envelope itself reports isError (message carries the server's own
 * text).
 */
export function parseEnvelope(result: McporterProcessResult): McporterEnvelope {
	if (result.killed) {
		const detail = result.stderr.trim();
		throw new TransportError(
			detail.length > 0
				? `mcporter call was terminated by timeout or abort before completing: ${detail}`
				: "mcporter call was terminated by timeout or abort before completing",
		);
	}
	if (result.code !== 0) {
		const detail = result.stderr.trim();
		throw new TransportError(
			detail.length > 0
				? `mcporter exited with code ${result.code}: ${detail}`
				: `mcporter exited with code ${result.code}`,
		);
	}

	let raw: RawEnvelope;
	try {
		raw = JSON.parse(result.stdout) as RawEnvelope;
	} catch {
		const detail = result.stderr.trim();
		throw new TransportError(
			detail.length > 0
				? `mcporter produced unparseable output: ${detail}`
				: "mcporter produced unparseable output (no JSON envelope on stdout)",
		);
	}

	const text = joinTextBlocks(raw.content);
	if (text === undefined) {
		throw new TransportError("mcporter envelope has no text content blocks — unknown output shape");
	}

	if (raw.isError === true) {
		throw new ServerToolError(text);
	}

	return { isError: false, text };
}
