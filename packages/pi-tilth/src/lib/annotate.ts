/**
 * Hashline-edit annotation of tilth_read output (design D7, hashline-compat
 * spec).
 *
 * The annotator recognizes the output shapes of `tilth_read` produced by the
 * smart/full and section/sections views, verifies every recognized shown
 * content line against the normalized disk content, rewrites verified lines
 * to pi-hashline-edit's `NN#HASH:content` format, and only then commits the
 * external read. Any mismatch or unrecognized shape → the file's output
 * passes through completely untouched and nothing is committed
 * (verify-then-commit).
 *
 * Observed server shapes (captured in test/fixtures):
 *  - Full view:     header `# <path> (N lines, ~T tokens) [full]`, blank, then
 *                   the raw file content, then one blank line — except for
 *                   files with no trailing newline, which end with content
 *                   and no blank. No gutters; CRLF `\r` is preserved.
 *                   Content may end with a `... truncated (N tokens omitted,
 *                   budget: M)` tail marker after a blank line.
 *  - Section view:  header `[section]`, blank, then `NN  <content>` gutters.
 *                   With multiple `sections`, each block is preceded by
 *                   `─── lines X-Y ───` delimiters. Trailing CR stripped by
 *                   the gutter renderer (full view preserves it).
 *  - Outline/signature/stripped/empty/generated: header tag differs
 *                   (`[outline]`, `[signature]`, `[stripped]`, `[empty]`,
 *                   `[generated — skipped]`) — never annotated.
 *  - Multi-path output concatenates per-file regions separated by a blank
 *                   line; each starts with its own header.
 */
import type { HashlineCompat } from "./hashline-bridge";

/** Header line: `# /abs/path (N lines, ~T tokens) [TAG]`. */
const HEADER_RE = /^# (\S+) \((\d+) lines?, ~[\d.]+k? tokens\) \[([^\]]+)\]$/;
/** Section gutter: `NN  <content>` — number, exactly two spaces, content. */
const GUTTER_RE = /^( *\d+) {2}(.*)$/;
/** Section delimiter: `─── lines X-Y ───`. */
const DELIMITER_RE = /^─── lines (\d+)-(\d+) ───$/;
/** tilth's own budget truncation tail marker. */
const TRUNCATION_MARKER_RE = /^\.\.\. truncated \(\d+ tokens? omitted, budget: \d+\)$/;
/** `> Related:` cross-reference footer after outline/some full views. */
const RELATED_RE = /^> Related: /;

interface FileRegion {
	/** 1-based line numbers that are shown (all lines in [start, end]). */
	lineNumbers: number[];
	/** Index into outputLines for each entry of lineNumbers. */
	outputIndexes: number[];
	/** True when content lines have a gutter (section view). */
	guttered: boolean;
	/** True when the region is bounded by a `... truncated (...)` marker — the
	 * server then shows fewer lines than the file has on disk. */
	truncatedTail: boolean;
}

interface FileBlock {
	path: string;
	tag: string;
	/** Inclusive [start, end) line indexes into outputLines for this block. */
	start: number;
	end: number;
	regions: FileRegion[];
	/** Content is contiguous (full view) — region covers startLine..startLine+n. */
	recognizable: boolean;
	/** Non-annotatable but harmless (outline, signature, empty, stripped...). */
	needsNoAnnotation: boolean;
}

function parseHeader(line: string): { path: string; tag: string } | null {
	const m = HEADER_RE.exec(line);
	if (!m || m[1] === undefined || m[3] === undefined) return null;
	return { path: m[1], tag: m[3] };
}

/**
 * Parse the regions inside one file block. Returns null when the block's
 * shape is unrecognized (→ passthrough).
 */
function parseRegions(outputLines: string[], block: { start: number; end: number; tag: string }): FileRegion[] | null {
	const regions: FileRegion[] = [];

	if (block.tag === "full") {
		// Full-view grammar (verified live): [header, separator blank, then
		// one output line per element of fileText.split("\n") — interior blank
		// lines are real content, plus one phantom blank element at the end for
		// newline-terminated files, plus (multi-path) one separator blank before
		// the next block]. Blank-count heuristics cannot distinguish a phantom/
		// separator blank from a real blank content line, so the region is
		// bounded structurally here and capped to the compat line count during
		// verification (which knows the true line count). A trailing `... truncated
		// (...)` marker (after a blank line) bounds the region.
		const contentStart = block.start + 2;
		if (contentStart > block.end) return [];
		let contentEnd = block.end;
		if (contentEnd >= contentStart && outputLines[contentEnd] === "") {
			contentEnd -= 1;
		}
		let truncatedTail = false;
		if (contentEnd >= contentStart && TRUNCATION_MARKER_RE.test(outputLines[contentEnd] ?? "")) {
			// Marker line and the blank line before it are not content.
			contentEnd -= 2;
			truncatedTail = true;
		}
		const lineNumbers: number[] = [];
		const outputIndexes: number[] = [];
		for (let i = contentStart; i <= contentEnd; i++) {
			lineNumbers.push(i - contentStart + 1);
			outputIndexes.push(i);
		}
		if (lineNumbers.length === 0) return [];
		regions.push({
			lineNumbers,
			outputIndexes,
			guttered: false,
			truncatedTail,
		});
		return regions;
	}

	if (block.tag === "section") {
		// Either a single guttered block, or multiple `─── lines X-Y ───`
		// delimited blocks.
		let i = block.start + 2; // skip header + blank
		if (i > block.end) return [];
		let current: { startLine: number; lineNumbers: number[]; outputIndexes: number[] } | null = null;

		const flush = () => {
			if (current && current.lineNumbers.length > 0) {
				regions.push({
					lineNumbers: current.lineNumbers,
					outputIndexes: current.outputIndexes,
					guttered: true,
					truncatedTail: false,
				});
			}
			current = null;
		};

		while (i <= block.end) {
			const line = outputLines[i] ?? "";
			if (line === "") {
				// Blank lines separate blocks/bound the tail — a blank is also a
				// content line in guttered form (`NN  ` with empty content).
				if (current) {
					// Blank could be content (`NN  ` gutter is never fully blank)
					// or a separator before the next delimiter/footer. Peek ahead.
					const prevIdx = current.outputIndexes[current.outputIndexes.length - 1] ?? -1;
					if (i === prevIdx + 1) {
						// Part of the current block: a trailing blank after content
						// is the block's own trailing newline (server emits one).
						// Only treat as separator if the next meaningful line is a
						// delimiter or block end.
						let j = i + 1;
						while (j <= block.end && (outputLines[j] ?? "") === "") j++;
						if (j > block.end || DELIMITER_RE.test(outputLines[j] ?? "")) {
							flush();
							i = j;
							continue;
						}
						// Otherwise: blank inside content is not possible in guttered
						// form (a blank content line renders as `NN  `), so treat as
						// separator noise → stop the block here.
						flush();
						i += 1;
						continue;
					}
				}
				i += 1;
				continue;
			}
			const delim = DELIMITER_RE.exec(line);
			if (delim) {
				flush();
				current = {
					startLine: Number(delim[1]),
					lineNumbers: [],
					outputIndexes: [],
				};
				i += 1;
				continue;
			}
			if (TRUNCATION_MARKER_RE.test(line) || RELATED_RE.test(line)) {
				flush();
				i += 1;
				continue;
			}
			const gutter = GUTTER_RE.exec(line);
			if (!gutter) {
				// Unrecognized line inside a section block → shape unknown.
				return null;
			}
			if (!current) {
				// Single-block section: infer start line from the first gutter.
				const first = Number(gutter[1]);
				current = {
					startLine: first,
					lineNumbers: [],
					outputIndexes: [],
				};
			}
			const lineNum = Number(gutter[1]);
			// Strict contiguity: gutter numbers must be consecutive.
			const expected =
				current.lineNumbers.length === 0
					? current.startLine
					: (current.lineNumbers.at(-1) ?? current.startLine - 1) + 1;
			if (lineNum !== expected) return null;
			current.lineNumbers.push(lineNum);
			current.outputIndexes.push(i);
			i += 1;
		}
		flush();
		return regions;
	}

	// Outline / signature / stripped / empty / generated — recognized shapes
	// that are never annotated (scaffolding, reshaped or server-generated).
	return [];
}

/**
 * Annotate one tilth_read output.
 *
 * Returns the (possibly rewritten) output text. Files whose every recognized
 * shown line verified byte-equal are rewritten to hashline anchors and
 * committed via `compat.commitExternalRead`. Files that fail verification or
 * whose shape is unrecognized pass through untouched with no commit.
 */
export async function annotateReadOutput(options: {
	output: string;
	/** Absolute file paths named by the call (already scoped). */
	targetPaths: string[];
	compat: HashlineCompat;
}): Promise<string> {
	const { output, targetPaths, compat } = options;
	if (targetPaths.length === 0) return output;

	const outputLines = output.split("\n");
	const byPath = new Map<string, string>();
	for (const p of targetPaths) {
		byPath.set(p, p);
	}
	// Match blocks to targets by exact absolute path equality; a header whose
	// path is not among the targets (e.g. canonicalized differently) is left
	// untouched and never committed (safe passthrough).
	const blockByPath = new Map<string, FileBlock>();

	// Parse blocks: a block starts at each recognized header line.
	const headerIndexes: number[] = [];
	for (let i = 0; i < outputLines.length; i++) {
		if (parseHeader(outputLines[i] ?? "")) headerIndexes.push(i);
	}
	if (headerIndexes.length === 0) return output;

	for (let h = 0; h < headerIndexes.length; h++) {
		const start = headerIndexes[h] ?? outputLines.length;
		const end =
			(h + 1 < headerIndexes.length ? (headerIndexes[h + 1] ?? outputLines.length) : outputLines.length) - 1;
		const header = parseHeader(outputLines[start] ?? "");
		if (!header) continue;
		const block: FileBlock = {
			path: header.path,
			tag: header.tag,
			start,
			end,
			regions: [],
			recognizable: false,
			needsNoAnnotation: false,
		};
		const regions = parseRegions(outputLines, block);
		if (regions === null) {
			block.recognizable = false;
		} else {
			block.recognizable = true;
			block.regions = regions;
			block.needsNoAnnotation = regions.length === 0;
		}
		blockByPath.set(header.path, block);
	}

	// Resolve each block to a target path.
	const rewritten = [...outputLines];

	for (const [blockPath, block] of blockByPath) {
		if (!block.recognizable) continue;
		const target = byPath.get(blockPath);
		if (!target) continue; // not named by the call → leave untouched

		if (block.needsNoAnnotation) {
			// Outline/empty/etc: recognized but never annotated, no commit.
			continue;
		}

		const normalized = await compat.readNormalizedForAnnotate(target);
		if (normalized === null) continue;
		const lines = normalized.lines;

		// Verify every shown line of every region.
		let allVerified = true;
		const replacements: { index: number; line1: number; content: string }[] = [];
		for (const region of block.regions) {
			// Full views are contiguous from line 1. The server may show up to
			// two extra blanks beyond the real content (the phantom trailing
			// element of fileText.split("\n") for newline-terminated files,
			// plus a multi-path separator blank) — blank-count heuristics can't
			// tell those apart from real blank content lines, so cap the region
			// at the true compat line count and require the excess to be blank.
			let shownCount = region.lineNumbers.length;
			if (!region.guttered && !region.truncatedTail) {
				const excess = shownCount - lines.length;
				if (excess < 0) {
					allVerified = false;
					break;
				}
				for (let e = 0; e < excess; e++) {
					const idx = region.outputIndexes[region.outputIndexes.length - 1 - e] ?? -1;
					if (idx < 0 || (outputLines[idx] ?? "\0") !== "") {
						allVerified = false;
						break;
					}
				}
				if (!allVerified) break;
				shownCount = lines.length;
			}
			for (let r = 0; r < shownCount; r++) {
				const line1 = region.lineNumbers[r] ?? -1;
				const idx = region.outputIndexes[r] ?? -1;
				if (line1 < 1 || idx < 0) {
					allVerified = false;
					break;
				}
				const raw = outputLines[idx] ?? "";
				let shown = raw;
				if (region.guttered) {
					const m = GUTTER_RE.exec(raw);
					if (!m || m[2] === undefined) {
						allVerified = false;
						break;
					}
					shown = m[2];
				}
				// Compat lines are \r-free (compat normalizes CRLF first); the
				// server's full view preserves CRLF \r while the section gutter
				// strips it. Strip one trailing \r from the shown text so both
				// views compare equal — and embed the stripped form in the anchor
				// line, matching native hashline reads (hash input strips \r too).
				if (shown.endsWith("\r")) {
					shown = shown.slice(0, -1);
				}
				const disk = lines[line1 - 1] ?? null;
				if (disk === null || shown !== disk) {
					allVerified = false;
					break;
				}
				replacements.push({ index: idx, line1, content: shown });
			}
			if (!allVerified) break;
		}
		if (!allVerified || replacements.length === 0) continue;

		for (const rep of replacements) {
			const anchor = compat.mintAnchor(lines, rep.line1);
			rewritten[rep.index] = `${rep.line1}#${anchor}:${rep.content}`;
		}
		try {
			await compat.commitExternalRead(target, normalized.normalized);
		} catch {
			// Commit failure (e.g. fs error resolving the canonical path) is
			// degraded to passthrough for this file: anchors in the output would
			// reference an uncommitted snapshot, so drop them rather than mint
			// anchors against a store that was never written.
			for (const rep of replacements) {
				rewritten[rep.index] = outputLines[rep.index] ?? "";
			}
		}
	}

	return rewritten.join("\n");
}
