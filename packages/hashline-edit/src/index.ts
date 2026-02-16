/**
 * Hashline edit mode — a line-addressable edit format using content hashes.
 *
 * Each line in a file is identified by its 1-indexed line number and a short
 * base16 hash derived from the line content (xxHash32 in Bun, deterministic
 * fallback elsewhere), truncated to 8 hex chars.
 * The combined `LINE:HASH` reference acts as both an address and a staleness check:
 * if the file has changed since the caller last read it, hash mismatches are caught
 * before any mutation occurs.
 *
 * Displayed format: `LINENUM:HASH|CONTENT`
 * Reference format: `"LINENUM:HASH"` (e.g. `"5:a3f19c2e"`)
 */

import { createHash } from "node:crypto";
import type { HashlineApplyResult, HashlineEdit, HashMismatch } from "./types.js";
import { HashlineMismatchError } from "./types.js";

export type { HashlineApplyResult, HashlineEdit, HashMismatch } from "./types.js";
export { HashlineMismatchError } from "./types.js";

type ParsedRefs =
	| { kind: "single"; ref: { line: number; hash: string } }
	| { kind: "range"; start: { line: number; hash: string }; end: { line: number; hash: string } }
	| { kind: "insertAfter"; after: { line: number; hash: string } };

function parseHashlineEdit(edit: HashlineEdit): { spec: ParsedRefs; dst: string } {
	if ("set_line" in edit) {
		return {
			spec: { kind: "single", ref: parseLineRef(edit.set_line.anchor) },
			dst: edit.set_line.new_text,
		};
	}
	if ("replace_lines" in edit) {
		const r = edit.replace_lines as Record<string, string>;
		const start = parseLineRef(r.start_anchor);
		if (!r.end_anchor) {
			return {
				spec: { kind: "single", ref: start },
				dst: r.new_text ?? "",
			};
		}
		const end = parseLineRef(r.end_anchor);
		return {
			spec: start.line === end.line ? { kind: "single", ref: start } : { kind: "range", start, end },
			dst: r.new_text ?? "",
		};
	}
	if ("replace" in edit) {
		throw new Error("replace edits are applied separately; do not pass them to applyHashlineEdits");
	}
	return {
		spec: { kind: "insertAfter", after: parseLineRef(edit.insert_after.anchor) },
		dst: edit.insert_after.text ?? (edit.insert_after as Record<string, string>).content ?? "",
	};
}

function splitDstLines(dst: string): string[] {
	return dst === "" ? [] : dst.split("\n");
}

const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*\d+:[0-9a-zA-Z]{1,16}\|/;
const DIFF_PLUS_RE = /^\+(?!\+)/;

function equalsIgnoringWhitespace(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function stripAllWhitespace(s: string): string {
	return s.replace(/\s+/g, "");
}

function stripTrailingContinuationTokens(s: string): string {
	return s.replace(/(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u, "");
}

function stripMergeOperatorChars(s: string): string {
	return s.replace(/[|&?]/g, "");
}

function leadingWhitespace(s: string): string {
	const match = s.match(/^\s*/);
	return match ? match[0] : "";
}

function restoreLeadingIndent(templateLine: string, line: string): string {
	if (line.length === 0) return line;
	const templateIndent = leadingWhitespace(templateLine);
	if (templateIndent.length === 0) return line;
	const indent = leadingWhitespace(line);
	if (indent.length > 0) return line;
	return templateIndent + line;
}

const CONFUSABLE_HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2212\uFE63\uFF0D]/g;

function normalizeConfusableHyphens(s: string): string {
	return s.replace(CONFUSABLE_HYPHENS_RE, "-");
}

function normalizeConfusableHyphensInLines(lines: string[]): string[] {
	return lines.map((l) => normalizeConfusableHyphens(l));
}

function restoreIndentForPairedReplacement(oldLines: string[], newLines: string[]): string[] {
	if (oldLines.length !== newLines.length) return newLines;
	let changed = false;
	const out = new Array<string>(newLines.length);
	for (let i = 0; i < newLines.length; i++) {
		const restored = restoreLeadingIndent(oldLines[i], newLines[i]);
		out[i] = restored;
		if (restored !== newLines[i]) changed = true;
	}
	return changed ? out : newLines;
}

function restoreOldWrappedLines(oldLines: string[], newLines: string[]): string[] {
	if (oldLines.length === 0 || newLines.length < 2) return newLines;

	const canonToOld = new Map<string, { line: string; count: number }>();
	for (const line of oldLines) {
		const canon = stripAllWhitespace(line);
		const bucket = canonToOld.get(canon);
		if (bucket) bucket.count++;
		else canonToOld.set(canon, { line, count: 1 });
	}

	const candidates: { start: number; len: number; replacement: string; canon: string }[] = [];
	for (let start = 0; start < newLines.length; start++) {
		for (let len = 2; len <= 10 && start + len <= newLines.length; len++) {
			const canonSpan = stripAllWhitespace(newLines.slice(start, start + len).join(""));
			const old = canonToOld.get(canonSpan);
			if (old && old.count === 1 && canonSpan.length >= 6) {
				candidates.push({ start, len, replacement: old.line, canon: canonSpan });
			}
		}
	}
	if (candidates.length === 0) return newLines;

	const canonCounts = new Map<string, number>();
	for (const c of candidates) {
		canonCounts.set(c.canon, (canonCounts.get(c.canon) ?? 0) + 1);
	}
	const uniqueCandidates = candidates.filter((c) => (canonCounts.get(c.canon) ?? 0) === 1);
	if (uniqueCandidates.length === 0) return newLines;

	uniqueCandidates.sort((a, b) => b.start - a.start);
	const out = [...newLines];
	for (const c of uniqueCandidates) {
		out.splice(c.start, c.len, c.replacement);
	}
	return out;
}

function stripInsertAnchorEchoAfter(anchorLine: string, dstLines: string[]): string[] {
	if (dstLines.length <= 1) return dstLines;
	if (equalsIgnoringWhitespace(dstLines[0], anchorLine)) {
		return dstLines.slice(1);
	}
	return dstLines;
}

function stripRangeBoundaryEcho(fileLines: string[], startLine: number, endLine: number, dstLines: string[]): string[] {
	const count = endLine - startLine + 1;
	if (dstLines.length <= 1 || dstLines.length <= count) return dstLines;

	let out = dstLines;
	const beforeIdx = startLine - 2;
	if (beforeIdx >= 0 && equalsIgnoringWhitespace(out[0], fileLines[beforeIdx])) {
		out = out.slice(1);
	}

	const afterIdx = endLine;
	if (
		afterIdx < fileLines.length &&
		out.length > 0 &&
		equalsIgnoringWhitespace(out[out.length - 1], fileLines[afterIdx])
	) {
		out = out.slice(0, -1);
	}

	return out;
}

function stripNewLinePrefixes(lines: string[]): string[] {
	let hashPrefixCount = 0;
	let diffPlusCount = 0;
	let nonEmpty = 0;
	for (const l of lines) {
		if (l.length === 0) continue;
		nonEmpty++;
		if (HASHLINE_PREFIX_RE.test(l)) hashPrefixCount++;
		if (DIFF_PLUS_RE.test(l)) diffPlusCount++;
	}
	if (nonEmpty === 0) return lines;

	const stripHash = hashPrefixCount > 0 && hashPrefixCount >= nonEmpty * 0.5;
	const stripPlus = !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;

	if (!stripHash && !stripPlus) return lines;

	return lines.map((l) => {
		if (stripHash) return l.replace(HASHLINE_PREFIX_RE, "");
		if (stripPlus) return l.replace(DIFF_PLUS_RE, "");
		return l;
	});
}

const HASH_LEN = 8;
const RADIX = 16;

function hash32(input: string): number {
	const bunHash = globalThis.Bun?.hash?.xxHash32;
	if (typeof bunHash === "function") {
		return bunHash(input);
	}
	const digest = createHash("sha256").update(input).digest();
	return digest.readUInt32BE(0);
}

/**
 * Compute a short base16 hash of a single line.
 *
 * Uses xxHash32 when available (Bun runtime), with a SHA-256-based 32-bit
 * fallback for non-Bun runtimes. Hashes exact line content (except trailing
 * `\r`) and truncates to {@link HASH_LEN} hex characters.
 */
export function computeLineHash(idx: number, line: string): string {
	if (line.endsWith("\r")) {
		line = line.slice(0, -1);
	}
	void idx;
	return hash32(line).toString(RADIX).padStart(HASH_LEN, "0").slice(0, HASH_LEN);
}

/**
 * Format file content with hashline prefixes for display.
 *
 * Each line becomes `LINENUM:HASH|CONTENT` where LINENUM is 1-indexed.
 */
export function formatHashLines(content: string, startLine = 1): string {
	const lines = content.split("\n");
	return lines
		.map((line, i) => {
			const num = startLine + i;
			const hash = computeLineHash(num, line);
			return `${num}:${hash}|${line}`;
		})
		.join("\n");
}

export interface HashlineStreamOptions {
	startLine?: number;
	maxChunkLines?: number;
	maxChunkBytes?: number;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
	return (
		typeof value === "object" &&
		value !== null &&
		"getReader" in value &&
		typeof (value as { getReader?: unknown }).getReader === "function"
	);
}

async function* bytesFromReadableStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value) yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Stream hashline-formatted output from a UTF-8 byte source.
 */
export async function* streamHashLinesFromUtf8(
	source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
	options: HashlineStreamOptions = {},
): AsyncGenerator<string> {
	const startLine = options.startLine ?? 1;
	const maxChunkLines = options.maxChunkLines ?? 200;
	const maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;
	const decoder = new TextDecoder("utf-8");
	const chunks = isReadableStream(source) ? bytesFromReadableStream(source) : source;
	let lineNum = startLine;
	let pending = "";
	let sawAnyText = false;
	let endedWithNewline = false;
	let outLines: string[] = [];
	let outBytes = 0;

	const flush = (): string | undefined => {
		if (outLines.length === 0) return undefined;
		const chunk = outLines.join("\n");
		outLines = [];
		outBytes = 0;
		return chunk;
	};

	const pushLine = (line: string): string[] => {
		const formatted = `${lineNum}:${computeLineHash(lineNum, line)}|${line}`;
		lineNum++;

		const chunksToYield: string[] = [];
		const sepBytes = outLines.length === 0 ? 0 : 1;
		const lineBytes = Buffer.byteLength(formatted, "utf-8");

		if (outLines.length > 0 && (outLines.length >= maxChunkLines || outBytes + sepBytes + lineBytes > maxChunkBytes)) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		outLines.push(formatted);
		outBytes += (outLines.length === 1 ? 0 : 1) + lineBytes;

		if (outLines.length >= maxChunkLines || outBytes >= maxChunkBytes) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		return chunksToYield;
	};

	const consumeText = (text: string): string[] => {
		if (text.length === 0) return [];
		sawAnyText = true;
		pending += text;
		const chunksToYield: string[] = [];
		while (true) {
			const idx = pending.indexOf("\n");
			if (idx === -1) break;
			const line = pending.slice(0, idx);
			pending = pending.slice(idx + 1);
			endedWithNewline = true;
			chunksToYield.push(...pushLine(line));
		}
		if (pending.length > 0) endedWithNewline = false;
		return chunksToYield;
	};

	for await (const chunk of chunks) {
		for (const out of consumeText(decoder.decode(chunk, { stream: true }))) {
			yield out;
		}
	}

	for (const out of consumeText(decoder.decode())) {
		yield out;
	}

	if (!sawAnyText) {
		for (const out of pushLine("")) {
			yield out;
		}
	} else if (pending.length > 0 || endedWithNewline) {
		for (const out of pushLine(pending)) {
			yield out;
		}
	}

	const last = flush();
	if (last) yield last;
}

/**
 * Stream hashline-formatted output from an (async) iterable of lines.
 */
export async function* streamHashLinesFromLines(
	lines: Iterable<string> | AsyncIterable<string>,
	options: HashlineStreamOptions = {},
): AsyncGenerator<string> {
	const startLine = options.startLine ?? 1;
	const maxChunkLines = options.maxChunkLines ?? 200;
	const maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;

	let lineNum = startLine;
	let outLines: string[] = [];
	let outBytes = 0;
	let sawAnyLine = false;

	const flush = (): string | undefined => {
		if (outLines.length === 0) return undefined;
		const chunk = outLines.join("\n");
		outLines = [];
		outBytes = 0;
		return chunk;
	};

	const pushLine = (line: string): string[] => {
		sawAnyLine = true;
		const formatted = `${lineNum}:${computeLineHash(lineNum, line)}|${line}`;
		lineNum++;

		const chunksToYield: string[] = [];
		const sepBytes = outLines.length === 0 ? 0 : 1;
		const lineBytes = Buffer.byteLength(formatted, "utf-8");

		if (outLines.length > 0 && (outLines.length >= maxChunkLines || outBytes + sepBytes + lineBytes > maxChunkBytes)) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		outLines.push(formatted);
		outBytes += (outLines.length === 1 ? 0 : 1) + lineBytes;

		if (outLines.length >= maxChunkLines || outBytes >= maxChunkBytes) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		return chunksToYield;
	};

	const asyncIterator = (lines as AsyncIterable<string>)[Symbol.asyncIterator];
	if (typeof asyncIterator === "function") {
		for await (const line of lines as AsyncIterable<string>) {
			for (const out of pushLine(line)) {
				yield out;
			}
		}
	} else {
		for (const line of lines as Iterable<string>) {
			for (const out of pushLine(line)) {
				yield out;
			}
		}
	}

	if (!sawAnyLine) {
		for (const out of pushLine("")) {
			yield out;
		}
	}

	const last = flush();
	if (last) yield last;
}

/**
 * Parse a line reference string like `"5:a3f19c2e"` into structured form.
 */
export function parseLineRef(ref: string): { line: number; hash: string } {
	const cleaned = ref
		.replace(/\|.*$/, "")
		.replace(/ {2}.*$/, "")
		.replace(/^>+\s*/, "")
		.trim();
	const normalized = cleaned.replace(/\s*:\s*/, ":");
	const match = normalized.match(new RegExp(`^(\\d+):([0-9a-fA-F]{${HASH_LEN}})$`));
	if (!match) {
		throw new Error(
			`Invalid line reference "${ref}". Expected format "LINE:HASH" with a ${HASH_LEN}-hex hash (e.g. "5:a3f19c2e").`,
		);
	}
	const line = Number.parseInt(match[1], 10);
	if (line < 1) {
		throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	}
	return { line, hash: match[2].toLowerCase() };
}

/**
 * Validate that a line reference points to an existing line with a matching hash.
 */
export function validateLineRef(ref: { line: number; hash: string }, fileLines: string[]): void {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
	}
	const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
	if (actualHash !== ref.hash.toLowerCase()) {
		throw new HashlineMismatchError([{ line: ref.line, expected: ref.hash, actual: actualHash }], fileLines);
	}
}

/**
 * Apply an array of hashline edits to file content.
 */
export function applyHashlineEdits(content: string, edits: HashlineEdit[]): HashlineApplyResult {
	if (edits.length === 0) {
		return { content, firstChangedLine: undefined };
	}

	const fileLines = content.split("\n");
	const originalFileLines = [...fileLines];
	let firstChangedLine: number | undefined;
	const noopEdits: Array<{ editIndex: number; loc: string; currentContent: string }> = [];

	const parsed = edits.map((edit) => {
		const parsedEdit = parseHashlineEdit(edit);
		return {
			spec: parsedEdit.spec,
			dstLines: stripNewLinePrefixes(splitDstLines(parsedEdit.dst)),
		};
	});

	function collectExplicitlyTouchedLines(): Set<number> {
		const touched = new Set<number>();
		for (const { spec } of parsed) {
			switch (spec.kind) {
				case "single":
					touched.add(spec.ref.line);
					break;
				case "range":
					for (let ln = spec.start.line; ln <= spec.end.line; ln++) touched.add(ln);
					break;
				case "insertAfter":
					touched.add(spec.after.line);
					break;
			}
		}
		return touched;
	}

	let explicitlyTouchedLines = collectExplicitlyTouchedLines();

	const mismatches: HashMismatch[] = [];

	function buildMismatch(ref: { line: number; hash: string }, line = ref.line): HashMismatch {
		return {
			line,
			expected: ref.hash,
			actual: computeLineHash(line, fileLines[line - 1]),
		};
	}

	function validateRef(ref: { line: number; hash: string }): void {
		if (ref.line < 1 || ref.line > fileLines.length) {
			throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
		}
		const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
		if (actualHash !== ref.hash.toLowerCase()) {
			mismatches.push(buildMismatch(ref));
		}
	}

	for (const { spec, dstLines } of parsed) {
		switch (spec.kind) {
			case "single": {
				validateRef(spec.ref);
				break;
			}
			case "insertAfter": {
				if (dstLines.length === 0) {
					throw new Error("Insert-after edit requires non-empty text");
				}
				validateRef(spec.after);
				break;
			}
			case "range": {
				if (spec.start.line > spec.end.line) {
					throw new Error(`Range start line ${spec.start.line} must be <= end line ${spec.end.line}`);
				}
				validateRef(spec.start);
				validateRef(spec.end);
				break;
			}
		}
	}

	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}

	explicitlyTouchedLines = collectExplicitlyTouchedLines();

	const seenEditKeys = new Map<string, number>();
	const dedupIndices = new Set<number>();
	for (let i = 0; i < parsed.length; i++) {
		const p = parsed[i];
		let lineKey: string;
		switch (p.spec.kind) {
			case "single":
				lineKey = `s:${p.spec.ref.line}`;
				break;
			case "range":
				lineKey = `r:${p.spec.start.line}:${p.spec.end.line}`;
				break;
			case "insertAfter":
				lineKey = `i:${p.spec.after.line}`;
				break;
		}
		const dstKey = `${lineKey}|${p.dstLines.join("\n")}`;
		if (seenEditKeys.has(dstKey)) {
			dedupIndices.add(i);
		} else {
			seenEditKeys.set(dstKey, i);
		}
	}
	if (dedupIndices.size > 0) {
		for (let i = parsed.length - 1; i >= 0; i--) {
			if (dedupIndices.has(i)) parsed.splice(i, 1);
		}
	}

	const annotated = parsed.map((p, idx) => {
		let sortLine: number;
		let precedence: number;
		switch (p.spec.kind) {
			case "single":
				sortLine = p.spec.ref.line;
				precedence = 0;
				break;
			case "range":
				sortLine = p.spec.end.line;
				precedence = 0;
				break;
			case "insertAfter":
				sortLine = p.spec.after.line;
				precedence = 1;
				break;
		}
		return { ...p, idx, sortLine, precedence };
	});

	annotated.sort((a, b) => {
		if (a.sortLine !== b.sortLine) {
			return b.sortLine - a.sortLine;
		}
		if (a.precedence !== b.precedence) {
			// For the same anchor line, apply insert_after before replacements so insertion
			// ends up after the replaced block, not inside it.
			return b.precedence - a.precedence;
		}
		if (a.precedence === 1) {
			// Multiple insert_after edits at one anchor are applied at the same splice index.
			// Process later edits first to preserve original input order in the final file.
			return b.idx - a.idx;
		}
		return a.idx - b.idx;
	});

	for (const { spec, dstLines, idx } of annotated) {
		switch (spec.kind) {
			case "single": {
				const merged = maybeExpandSingleLineMerge(spec.ref.line, dstLines);
				if (merged) {
					const origLines = originalFileLines.slice(merged.startLine - 1, merged.startLine - 1 + merged.deleteCount);
					let nextLines = merged.newLines;
					nextLines = restoreIndentForPairedReplacement([origLines[0] ?? ""], nextLines);
					if (origLines.join("\n") === nextLines.join("\n") && origLines.some((l) => CONFUSABLE_HYPHENS_RE.test(l))) {
						nextLines = normalizeConfusableHyphensInLines(nextLines);
					}
					if (origLines.join("\n") === nextLines.join("\n")) {
						noopEdits.push({
							editIndex: idx,
							loc: `${spec.ref.line}:${spec.ref.hash}`,
							currentContent: origLines.join("\n"),
						});
						break;
					}
					fileLines.splice(merged.startLine - 1, merged.deleteCount, ...nextLines);
					trackFirstChanged(merged.startLine);
					break;
				}

				const count = 1;
				const origLines = originalFileLines.slice(spec.ref.line - 1, spec.ref.line);
				let stripped = stripRangeBoundaryEcho(originalFileLines, spec.ref.line, spec.ref.line, dstLines);
				stripped = restoreOldWrappedLines(origLines, stripped);
				let newLines = restoreIndentForPairedReplacement(origLines, stripped);
				if (origLines.join("\n") === newLines.join("\n") && origLines.some((l) => CONFUSABLE_HYPHENS_RE.test(l))) {
					newLines = normalizeConfusableHyphensInLines(newLines);
				}
				if (origLines.join("\n") === newLines.join("\n")) {
					noopEdits.push({
						editIndex: idx,
						loc: `${spec.ref.line}:${spec.ref.hash}`,
						currentContent: origLines.join("\n"),
					});
					break;
				}
				fileLines.splice(spec.ref.line - 1, count, ...newLines);
				trackFirstChanged(spec.ref.line);
				break;
			}
			case "range": {
				const count = spec.end.line - spec.start.line + 1;
				const origLines = originalFileLines.slice(spec.start.line - 1, spec.start.line - 1 + count);
				let stripped = stripRangeBoundaryEcho(originalFileLines, spec.start.line, spec.end.line, dstLines);
				stripped = restoreOldWrappedLines(origLines, stripped);
				let newLines = restoreIndentForPairedReplacement(origLines, stripped);
				if (origLines.join("\n") === newLines.join("\n") && origLines.some((l) => CONFUSABLE_HYPHENS_RE.test(l))) {
					newLines = normalizeConfusableHyphensInLines(newLines);
				}
				if (origLines.join("\n") === newLines.join("\n")) {
					noopEdits.push({
						editIndex: idx,
						loc: `${spec.start.line}:${spec.start.hash}`,
						currentContent: origLines.join("\n"),
					});
					break;
				}
				fileLines.splice(spec.start.line - 1, count, ...newLines);
				trackFirstChanged(spec.start.line);
				break;
			}
			case "insertAfter": {
				const anchorLine = originalFileLines[spec.after.line - 1];
				const inserted = stripInsertAnchorEchoAfter(anchorLine, dstLines);
				if (inserted.length === 0) {
					noopEdits.push({
						editIndex: idx,
						loc: `${spec.after.line}:${spec.after.hash}`,
						currentContent: originalFileLines[spec.after.line - 1],
					});
					break;
				}
				fileLines.splice(spec.after.line, 0, ...inserted);
				trackFirstChanged(spec.after.line + 1);
				break;
			}
		}
	}

	const warnings: string[] = [];
	let diffLineCount = Math.abs(fileLines.length - originalFileLines.length);
	for (let i = 0; i < Math.min(fileLines.length, originalFileLines.length); i++) {
		if (fileLines[i] !== originalFileLines[i]) diffLineCount++;
	}
	if (diffLineCount > edits.length * 4) {
		warnings.push(
			`Edit changed ${diffLineCount} lines across ${edits.length} operations — verify no unintended reformatting.`,
		);
	}

	return {
		content: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
		...(noopEdits.length > 0 ? { noopEdits } : {}),
	};

	function trackFirstChanged(line: number): void {
		if (firstChangedLine === undefined || line < firstChangedLine) {
			firstChangedLine = line;
		}
	}

	function maybeExpandSingleLineMerge(
		line: number,
		dst: string[],
	): { startLine: number; deleteCount: number; newLines: string[] } | null {
		if (dst.length !== 1) return null;
		if (line < 1 || line > fileLines.length) return null;

		const newLine = dst[0];
		const newCanon = stripAllWhitespace(newLine);
		const newCanonForMergeOps = stripMergeOperatorChars(newCanon);
		if (newCanon.length === 0) return null;

		const orig = fileLines[line - 1];
		const origCanon = stripAllWhitespace(orig);
		const origCanonForMatch = stripTrailingContinuationTokens(origCanon);
		const origCanonForMergeOps = stripMergeOperatorChars(origCanon);
		const origLooksLikeContinuation = origCanonForMatch.length < origCanon.length;
		if (origCanon.length === 0) return null;

		const nextIdx = line;
		const prevIdx = line - 2;

		if (origLooksLikeContinuation && nextIdx < fileLines.length && !explicitlyTouchedLines.has(line + 1)) {
			const next = fileLines[nextIdx];
			const nextCanon = stripAllWhitespace(next);
			const a = newCanon.indexOf(origCanonForMatch);
			const b = newCanon.indexOf(nextCanon);
			if (a !== -1 && b !== -1 && a < b && newCanon.length <= origCanon.length + nextCanon.length + 32) {
				return { startLine: line, deleteCount: 2, newLines: [newLine] };
			}
		}

		if (prevIdx >= 0 && !explicitlyTouchedLines.has(line - 1)) {
			const prev = fileLines[prevIdx];
			const prevCanon = stripAllWhitespace(prev);
			const prevCanonForMatch = stripTrailingContinuationTokens(prevCanon);
			const prevLooksLikeContinuation = prevCanonForMatch.length < prevCanon.length;
			if (!prevLooksLikeContinuation) return null;
			const a = newCanonForMergeOps.indexOf(stripMergeOperatorChars(prevCanonForMatch));
			const b = newCanonForMergeOps.indexOf(origCanonForMergeOps);
			if (a !== -1 && b !== -1 && a < b && newCanon.length <= prevCanon.length + origCanon.length + 32) {
				return { startLine: line - 1, deleteCount: 2, newLines: [newLine] };
			}
		}

		return null;
	}
}
