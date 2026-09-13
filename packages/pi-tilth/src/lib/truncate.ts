/**
 * Output truncation — pi-colgrep pattern.
 *
 * Uses pi's shared `truncateHead` with the host defaults; when truncated, the
 * full output is written to a unique `$TMPDIR/tilth-<pid>-<ts>-<seq>.txt` and
 * a pointer is appended to the returned text.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";

let spillSeq = 0;

export interface TruncationOutcome {
	/** Text to return to the model (possibly truncated with a pointer). */
	text: string;
	/** Whether the output was truncated. */
	truncated: boolean;
	/** Path of the full-output file when truncated. */
	fullOutputPath?: string;
}

export async function applyTruncation(
	output: string,
	options?: { maxLines?: number; maxBytes?: number },
): Promise<TruncationOutcome> {
	const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
	const truncation = truncateHead(output, { maxLines, maxBytes });

	if (!truncation.truncated) {
		return { text: output, truncated: false };
	}

	// Unique per call: same-millisecond parallel tool calls must not overwrite
	// each other's spill files.
	const tempPath = join(tmpdir(), `tilth-${process.pid}-${Date.now()}-${spillSeq++}.txt`);
	await writeFile(tempPath, output);
	return {
		text: `${truncation.content}\n[Truncated. Full output: ${tempPath}]`,
		truncated: true,
		fullOutputPath: tempPath,
	};
}
