/**
 * Fuzzy matching utilities for the edit tool.
 *
 * Provides both character-level and line-level fuzzy matching with progressive
 * fallback strategies for finding text in files.
 */
import { countLeadingWhitespace, normalizeForFuzzy, normalizeUnicode } from "./normalize.js";
import type {
	ContextLineResult,
	FuzzyMatch,
	MatchOutcome,
	SequenceMatchStrategy,
	SequenceSearchResult,
} from "./types.js";

export { countLeadingWhitespace, normalizeForFuzzy, normalizeUnicode } from "./normalize.js";
export { EditMatchError } from "./types.js";
export type { ContextLineResult, FuzzyMatch, MatchOutcome, SequenceMatchStrategy, SequenceSearchResult };

/** Default similarity threshold for fuzzy matching */
export const DEFAULT_FUZZY_THRESHOLD = 0.95;

const SEQUENCE_FUZZY_THRESHOLD = 0.92;
const FALLBACK_THRESHOLD = 0.8;
const CONTEXT_FUZZY_THRESHOLD = 0.8;
const PARTIAL_MATCH_MIN_LENGTH = 6;
const PARTIAL_MATCH_MIN_RATIO = 0.3;
const OCCURRENCE_PREVIEW_CONTEXT = 5;
const OCCURRENCE_PREVIEW_MAX_LEN = 80;

/** Compute Levenshtein distance between two strings */
export function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = prev[j] + 1;
			const insertion = curr[j - 1] + 1;
			const substitution = prev[j - 1] + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[bLen];
}

/** Compute similarity score between two strings (0 to 1) */
export function similarity(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) return 1;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	const distance = levenshteinDistance(a, b);
	return 1 - distance / maxLen;
}

interface PreparedLine {
	raw: string;
	normalized: string;
	indent: number;
	nonEmpty: boolean;
}

function prepareLines(lines: string[]): PreparedLine[] {
	return lines.map((line) => {
		const trimmed = line.trim();
		const nonEmpty = trimmed.length > 0;
		return {
			raw: line,
			normalized: nonEmpty ? normalizeForFuzzy(trimmed) : "",
			indent: countLeadingWhitespace(line),
			nonEmpty,
		};
	});
}

function computeRelativeIndentDepths(lines: PreparedLine[]): number[] {
	const nonEmptyIndents: number[] = [];
	for (const line of lines) {
		if (line.nonEmpty) nonEmptyIndents.push(line.indent);
	}
	const minIndent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : 0;
	const indentSteps = nonEmptyIndents.map((indent) => indent - minIndent).filter((step) => step > 0);
	const indentUnit = indentSteps.length > 0 ? Math.min(...indentSteps) : 1;

	return lines.map((line) => {
		if (!line.nonEmpty || indentUnit <= 0) return 0;
		return Math.round((line.indent - minIndent) / indentUnit);
	});
}

function normalizePreparedLines(lines: PreparedLine[], includeDepth: boolean): string[] {
	const indentDepths = includeDepth ? computeRelativeIndentDepths(lines) : null;
	return lines.map((line, index) => {
		const prefix = indentDepths ? `${indentDepths[index]}|` : "|";
		if (!line.nonEmpty) return prefix;
		return `${prefix}${line.normalized}`;
	});
}

function computeWindowIndentMeta(
	lines: PreparedLine[],
	start: number,
	count: number,
): { minIndent: number; indentUnit: number } {
	let minIndent = Number.POSITIVE_INFINITY;
	for (let i = 0; i < count; i++) {
		const line = lines[start + i];
		if (line.nonEmpty && line.indent < minIndent) {
			minIndent = line.indent;
		}
	}

	if (!Number.isFinite(minIndent)) {
		return { minIndent: 0, indentUnit: 1 };
	}

	let indentUnit = Number.POSITIVE_INFINITY;
	for (let i = 0; i < count; i++) {
		const line = lines[start + i];
		if (!line.nonEmpty) continue;
		const step = line.indent - minIndent;
		if (step > 0 && step < indentUnit) {
			indentUnit = step;
		}
	}

	return {
		minIndent,
		indentUnit: Number.isFinite(indentUnit) ? indentUnit : 1,
	};
}

function normalizeWindowLine(line: PreparedLine, includeDepth: boolean, minIndent: number, indentUnit: number): string {
	if (!includeDepth) {
		return line.nonEmpty ? `|${line.normalized}` : "|";
	}

	const depth = !line.nonEmpty || indentUnit <= 0 ? 0 : Math.round((line.indent - minIndent) / indentUnit);
	return line.nonEmpty ? `${depth}|${line.normalized}` : `${depth}|`;
}

function computeLineOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets.push(offset);
		offset += lines[i].length;
		if (i < lines.length - 1) offset += 1;
	}
	return offsets;
}

interface BestFuzzyMatchResult {
	best?: FuzzyMatch;
	aboveThresholdCount: number;
	secondBestScore: number;
}

function findBestFuzzyMatchCore(
	contentLines: string[],
	contentPrepared: PreparedLine[],
	targetLines: string[],
	targetPrepared: PreparedLine[],
	offsets: number[],
	threshold: number,
	includeDepth: boolean,
): BestFuzzyMatchResult {
	const targetNormalized = normalizePreparedLines(targetPrepared, includeDepth);
	const targetLength = targetLines.length;

	let best: FuzzyMatch | undefined;
	let bestScore = -1;
	let secondBestScore = -1;
	let aboveThresholdCount = 0;

	for (let start = 0; start <= contentLines.length - targetLength; start++) {
		const { minIndent, indentUnit } = includeDepth
			? computeWindowIndentMeta(contentPrepared, start, targetLength)
			: { minIndent: 0, indentUnit: 1 };

		let accumulated = 0;
		let processed = 0;
		let bailedOut = false;

		for (let i = 0; i < targetLength; i++) {
			const windowLine = normalizeWindowLine(contentPrepared[start + i], includeDepth, minIndent, indentUnit);
			accumulated += similarity(targetNormalized[i], windowLine);
			processed = i + 1;

			const remaining = targetLength - processed;
			const maxPossible = (accumulated + remaining) / targetLength;
			if (bestScore < threshold) {
				if (maxPossible <= bestScore) {
					bailedOut = true;
					break;
				}
			} else if (maxPossible < threshold && maxPossible <= bestScore) {
				bailedOut = true;
				break;
			}
		}

		const score = bailedOut ? (accumulated + (targetLength - processed)) / targetLength : accumulated / targetLength;

		if (!bailedOut && score >= threshold) {
			aboveThresholdCount++;
		}

		if (score > bestScore) {
			secondBestScore = bestScore;
			bestScore = score;
			best = {
				actualText: contentLines.slice(start, start + targetLength).join("\n"),
				startIndex: offsets[start],
				startLine: start + 1,
				confidence: score,
			};
		} else if (score > secondBestScore) {
			secondBestScore = score;
		}
	}

	return { best, aboveThresholdCount, secondBestScore };
}

function findBestFuzzyMatch(content: string, target: string, threshold: number): BestFuzzyMatchResult {
	const contentLines = content.split("\n");
	const targetLines = target.split("\n");

	if (targetLines.length === 0 || target.length === 0) {
		return { aboveThresholdCount: 0, secondBestScore: 0 };
	}
	if (targetLines.length > contentLines.length) {
		return { aboveThresholdCount: 0, secondBestScore: 0 };
	}

	const contentPrepared = prepareLines(contentLines);
	const targetPrepared = prepareLines(targetLines);
	const offsets = computeLineOffsets(contentLines);
	let result = findBestFuzzyMatchCore(
		contentLines,
		contentPrepared,
		targetLines,
		targetPrepared,
		offsets,
		threshold,
		true,
	);

	if (result.best && result.best.confidence < threshold && result.best.confidence >= FALLBACK_THRESHOLD) {
		const noDepthResult = findBestFuzzyMatchCore(
			contentLines,
			contentPrepared,
			targetLines,
			targetPrepared,
			offsets,
			threshold,
			false,
		);
		if (noDepthResult.best && noDepthResult.best.confidence > result.best.confidence) {
			result = noDepthResult;
		}
	}

	return result;
}

function countOccurrencesWithSample(
	content: string,
	target: string,
	sampleLimit = 5,
): { count: number; sample: number[] } {
	if (target.length === 0) return { count: 0, sample: [] };
	let count = 0;
	const sample: number[] = [];
	let searchStart = 0;
	while (searchStart <= content.length) {
		const idx = content.indexOf(target, searchStart);
		if (idx === -1) break;
		count++;
		if (sample.length < sampleLimit) sample.push(idx);
		searchStart = idx + Math.max(1, target.length);
	}
	return { count, sample };
}

/**
 * Find a match for target text within content.
 * Used primarily for replace-mode edits.
 */
export function findMatch(
	content: string,
	target: string,
	options: { allowFuzzy: boolean; threshold?: number },
): MatchOutcome {
	if (target.length === 0) {
		return {};
	}

	const exactIndex = content.indexOf(target);
	if (exactIndex !== -1) {
		const { count: occurrences, sample } = countOccurrencesWithSample(content, target, 5);
		if (occurrences > 1) {
			const contentLines = content.split("\n");
			const occurrenceLines: number[] = [];
			const occurrencePreviews: string[] = [];
			for (const idx of sample) {
				const lineNumber = content.slice(0, idx).split("\n").length;
				occurrenceLines.push(lineNumber);
				const start = Math.max(0, lineNumber - 1 - OCCURRENCE_PREVIEW_CONTEXT);
				const end = Math.min(contentLines.length, lineNumber + OCCURRENCE_PREVIEW_CONTEXT + 1);
				const previewLines = contentLines.slice(start, end);
				const preview = previewLines
					.map((line, idx) => {
						const num = start + idx + 1;
						return `  ${num} | ${line.length > OCCURRENCE_PREVIEW_MAX_LEN ? `${line.slice(0, OCCURRENCE_PREVIEW_MAX_LEN - 1)}…` : line}`;
					})
					.join("\n");
				occurrencePreviews.push(preview);
			}
			return { occurrences, occurrenceLines, occurrencePreviews };
		}
		const startLine = content.slice(0, exactIndex).split("\n").length;
		return {
			match: {
				actualText: target,
				startIndex: exactIndex,
				startLine,
				confidence: 1,
			},
		};
	}

	const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
	const { best, aboveThresholdCount, secondBestScore } = findBestFuzzyMatch(content, target, threshold);

	if (!best) {
		return {};
	}

	if (options.allowFuzzy && best.confidence >= threshold) {
		if (aboveThresholdCount === 1) {
			return { match: best, closest: best };
		}
		const dominantDelta = 0.08;
		const dominantMin = 0.97;
		if (
			aboveThresholdCount > 1 &&
			best.confidence >= dominantMin &&
			best.confidence - secondBestScore >= dominantDelta
		) {
			return { match: best, closest: best, fuzzyMatches: aboveThresholdCount, dominantFuzzy: true };
		}
	}

	return { closest: best, fuzzyMatches: aboveThresholdCount };
}

function matchesAt(lines: string[], pattern: string[], i: number, compare: (a: string, b: string) => boolean): boolean {
	for (let j = 0; j < pattern.length; j++) {
		if (!compare(lines[i + j], pattern[j])) {
			return false;
		}
	}
	return true;
}

function fuzzyScoreAt(lines: string[], pattern: string[], i: number): number {
	let totalScore = 0;
	for (let j = 0; j < pattern.length; j++) {
		const lineNorm = normalizeForFuzzy(lines[i + j]);
		const patternNorm = normalizeForFuzzy(pattern[j]);
		totalScore += similarity(lineNorm, patternNorm);
	}
	return totalScore / pattern.length;
}

function lineStartsWithPattern(line: string, pattern: string): boolean {
	const lineNorm = normalizeForFuzzy(line);
	const patternNorm = normalizeForFuzzy(pattern);
	if (patternNorm.length === 0) return lineNorm.length === 0;
	return lineNorm.startsWith(patternNorm);
}

function lineIncludesPattern(line: string, pattern: string): boolean {
	const lineNorm = normalizeForFuzzy(line);
	const patternNorm = normalizeForFuzzy(pattern);
	if (patternNorm.length === 0) return lineNorm.length === 0;
	if (patternNorm.length < PARTIAL_MATCH_MIN_LENGTH) return false;
	if (!lineNorm.includes(patternNorm)) return false;
	return patternNorm.length / Math.max(1, lineNorm.length) >= PARTIAL_MATCH_MIN_RATIO;
}

function stripCommentPrefix(line: string): string {
	let trimmed = line.trimStart();
	if (trimmed.startsWith("/*")) {
		trimmed = trimmed.slice(2);
	} else if (trimmed.startsWith("*/")) {
		trimmed = trimmed.slice(2);
	} else if (trimmed.startsWith("//")) {
		trimmed = trimmed.slice(2);
	} else if (trimmed.startsWith("*")) {
		trimmed = trimmed.slice(1);
	} else if (trimmed.startsWith("#")) {
		trimmed = trimmed.slice(1);
	} else if (trimmed.startsWith(";")) {
		trimmed = trimmed.slice(1);
	} else if (trimmed.startsWith("/") && trimmed[1] === " ") {
		trimmed = trimmed.slice(1);
	}
	return trimmed.trimStart();
}

/**
 * Find a sequence of pattern lines within content lines.
 */
export function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
	options?: { allowFuzzy?: boolean },
): SequenceSearchResult {
	const allowFuzzy = options?.allowFuzzy ?? true;

	if (pattern.length === 0) {
		return { index: start, confidence: 1.0, strategy: "exact" };
	}

	if (pattern.length > lines.length) {
		return { index: undefined, confidence: 0 };
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const maxStart = lines.length - pattern.length;

	const runExactPasses = (from: number, to: number): SequenceSearchResult | undefined => {
		for (let i = from; i <= to; i++) {
			if (matchesAt(lines, pattern, i, (a, b) => a === b)) {
				return { index: i, confidence: 1.0, strategy: "exact" };
			}
		}

		for (let i = from; i <= to; i++) {
			if (matchesAt(lines, pattern, i, (a, b) => a.trimEnd() === b.trimEnd())) {
				return { index: i, confidence: 0.99, strategy: "trim-trailing" };
			}
		}

		for (let i = from; i <= to; i++) {
			if (matchesAt(lines, pattern, i, (a, b) => a.trim() === b.trim())) {
				return { index: i, confidence: 0.98, strategy: "trim" };
			}
		}

		for (let i = from; i <= to; i++) {
			if (matchesAt(lines, pattern, i, (a, b) => stripCommentPrefix(a) === stripCommentPrefix(b))) {
				return { index: i, confidence: 0.975, strategy: "comment-prefix" };
			}
		}

		for (let i = from; i <= to; i++) {
			if (matchesAt(lines, pattern, i, (a, b) => normalizeUnicode(a) === normalizeUnicode(b))) {
				return { index: i, confidence: 0.97, strategy: "unicode" };
			}
		}

		if (!allowFuzzy) {
			return undefined;
		}

		{
			let firstMatch: number | undefined;
			let matchCount = 0;
			const matchIndices: number[] = [];
			for (let i = from; i <= to; i++) {
				if (matchesAt(lines, pattern, i, lineStartsWithPattern)) {
					if (firstMatch === undefined) firstMatch = i;
					matchCount++;
					if (matchIndices.length < 5) matchIndices.push(i);
				}
			}
			if (matchCount > 0) {
				return { index: firstMatch, confidence: 0.965, matchCount, matchIndices, strategy: "prefix" };
			}
		}

		{
			let firstMatch: number | undefined;
			let matchCount = 0;
			const matchIndices: number[] = [];
			for (let i = from; i <= to; i++) {
				if (matchesAt(lines, pattern, i, lineIncludesPattern)) {
					if (firstMatch === undefined) firstMatch = i;
					matchCount++;
					if (matchIndices.length < 5) matchIndices.push(i);
				}
			}
			if (matchCount > 0) {
				return { index: firstMatch, confidence: 0.94, matchCount, matchIndices, strategy: "substring" };
			}
		}

		return undefined;
	};

	const primaryPassResult = runExactPasses(searchStart, maxStart);
	if (primaryPassResult) {
		return primaryPassResult;
	}

	if (eof && searchStart > start) {
		const fromStartResult = runExactPasses(start, maxStart);
		if (fromStartResult) {
			return fromStartResult;
		}
	}

	if (!allowFuzzy) {
		return { index: undefined, confidence: 0 };
	}

	let bestIndex: number | undefined;
	let bestScore = 0;
	let secondBestScore = 0;
	let matchCount = 0;
	const matchIndices: number[] = [];

	for (let i = searchStart; i <= maxStart; i++) {
		const score = fuzzyScoreAt(lines, pattern, i);
		if (score >= SEQUENCE_FUZZY_THRESHOLD) {
			matchCount++;
			if (matchIndices.length < 5) matchIndices.push(i);
		}
		if (score > bestScore) {
			secondBestScore = bestScore;
			bestScore = score;
			bestIndex = i;
		} else if (score > secondBestScore) {
			secondBestScore = score;
		}
	}

	if (eof && searchStart > start) {
		for (let i = start; i < searchStart; i++) {
			const score = fuzzyScoreAt(lines, pattern, i);
			if (score >= SEQUENCE_FUZZY_THRESHOLD) {
				matchCount++;
				if (matchIndices.length < 5) matchIndices.push(i);
			}
			if (score > bestScore) {
				secondBestScore = bestScore;
				bestScore = score;
				bestIndex = i;
			} else if (score > secondBestScore) {
				secondBestScore = score;
			}
		}
	}

	if (bestIndex !== undefined && bestScore >= SEQUENCE_FUZZY_THRESHOLD) {
		const dominantDelta = 0.08;
		const dominantMin = 0.97;
		if (matchCount > 1 && bestScore >= dominantMin && bestScore - secondBestScore >= dominantDelta) {
			return {
				index: bestIndex,
				confidence: bestScore,
				matchCount: 1,
				matchIndices,
				strategy: "fuzzy-dominant",
			};
		}
		return { index: bestIndex, confidence: bestScore, matchCount, matchIndices, strategy: "fuzzy" };
	}

	const patternText = pattern.join("\n");
	const contentText = lines.slice(start).join("\n");
	const CHARACTER_MATCH_THRESHOLD = 0.92;
	const matchOutcome = findMatch(contentText, patternText, {
		allowFuzzy: true,
		threshold: CHARACTER_MATCH_THRESHOLD,
	});

	if (matchOutcome.match) {
		const matchedContent = contentText.substring(0, matchOutcome.match.startIndex);
		const lineIndex = start + matchedContent.split("\n").length - 1;
		const fallbackMatchCount = matchOutcome.occurrences ?? matchOutcome.fuzzyMatches ?? 1;
		return {
			index: lineIndex,
			confidence: matchOutcome.match.confidence,
			matchCount: fallbackMatchCount,
			strategy: "character",
		};
	}

	const fallbackMatchCount = matchOutcome.occurrences ?? matchOutcome.fuzzyMatches;
	return { index: undefined, confidence: bestScore, matchCount: fallbackMatchCount };
}

export function findClosestSequenceMatch(
	lines: string[],
	pattern: string[],
	options?: { start?: number; eof?: boolean },
): { index: number | undefined; confidence: number; strategy: SequenceMatchStrategy } {
	if (pattern.length === 0) {
		return { index: options?.start ?? 0, confidence: 1, strategy: "exact" };
	}
	if (pattern.length > lines.length) {
		return { index: undefined, confidence: 0, strategy: "fuzzy" };
	}

	const start = options?.start ?? 0;
	const eof = options?.eof ?? false;
	const maxStart = lines.length - pattern.length;
	const searchStart = eof && lines.length >= pattern.length ? maxStart : start;

	let bestIndex: number | undefined;
	let bestScore = 0;

	for (let i = searchStart; i <= maxStart; i++) {
		const score = fuzzyScoreAt(lines, pattern, i);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (eof && searchStart > start) {
		for (let i = start; i < searchStart; i++) {
			const score = fuzzyScoreAt(lines, pattern, i);
			if (score > bestScore) {
				bestScore = score;
				bestIndex = i;
			}
		}
	}

	return { index: bestIndex, confidence: bestScore, strategy: "fuzzy" };
}

/**
 * Find a context line in the file using progressive matching strategies.
 */
export function findContextLine(
	lines: string[],
	context: string,
	startFrom: number,
	options?: { allowFuzzy?: boolean; skipFunctionFallback?: boolean },
): ContextLineResult {
	const allowFuzzy = options?.allowFuzzy ?? true;
	const trimmedContext = context.trim();

	{
		let firstMatch: number | undefined;
		let matchCount = 0;
		const matchIndices: number[] = [];
		for (let i = startFrom; i < lines.length; i++) {
			if (lines[i] === context) {
				if (firstMatch === undefined) firstMatch = i;
				matchCount++;
				if (matchIndices.length < 5) matchIndices.push(i);
			}
		}
		if (matchCount > 0) {
			return { index: firstMatch, confidence: 1.0, matchCount, matchIndices, strategy: "exact" };
		}
	}

	{
		let firstMatch: number | undefined;
		let matchCount = 0;
		const matchIndices: number[] = [];
		for (let i = startFrom; i < lines.length; i++) {
			if (lines[i].trim() === trimmedContext) {
				if (firstMatch === undefined) firstMatch = i;
				matchCount++;
				if (matchIndices.length < 5) matchIndices.push(i);
			}
		}
		if (matchCount > 0) {
			return { index: firstMatch, confidence: 0.99, matchCount, matchIndices, strategy: "trim" };
		}
	}

	const normalizedContext = normalizeUnicode(context);
	{
		let firstMatch: number | undefined;
		let matchCount = 0;
		const matchIndices: number[] = [];
		for (let i = startFrom; i < lines.length; i++) {
			if (normalizeUnicode(lines[i]) === normalizedContext) {
				if (firstMatch === undefined) firstMatch = i;
				matchCount++;
				if (matchIndices.length < 5) matchIndices.push(i);
			}
		}
		if (matchCount > 0) {
			return { index: firstMatch, confidence: 0.98, matchCount, matchIndices, strategy: "unicode" };
		}
	}

	if (!allowFuzzy) {
		return { index: undefined, confidence: 0 };
	}

	const contextNorm = normalizeForFuzzy(context);
	if (contextNorm.length > 0) {
		let firstMatch: number | undefined;
		let matchCount = 0;
		const matchIndices: number[] = [];
		for (let i = startFrom; i < lines.length; i++) {
			const lineNorm = normalizeForFuzzy(lines[i]);
			if (lineNorm.startsWith(contextNorm)) {
				if (firstMatch === undefined) firstMatch = i;
				matchCount++;
				if (matchIndices.length < 5) matchIndices.push(i);
			}
		}
		if (matchCount > 0) {
			return { index: firstMatch, confidence: 0.96, matchCount, matchIndices, strategy: "prefix" };
		}
	}

	if (contextNorm.length >= PARTIAL_MATCH_MIN_LENGTH) {
		const allSubstringMatches: Array<{ index: number; ratio: number }> = [];
		for (let i = startFrom; i < lines.length; i++) {
			const lineNorm = normalizeForFuzzy(lines[i]);
			if (lineNorm.includes(contextNorm)) {
				const ratio = contextNorm.length / Math.max(1, lineNorm.length);
				allSubstringMatches.push({ index: i, ratio });
			}
		}
		const matchIndices = allSubstringMatches.slice(0, 5).map((match) => match.index);

		if (allSubstringMatches.length === 1) {
			return {
				index: allSubstringMatches[0].index,
				confidence: 0.94,
				matchCount: 1,
				matchIndices,
				strategy: "substring",
			};
		}

		let firstMatch: number | undefined;
		let matchCount = 0;
		for (const match of allSubstringMatches) {
			if (match.ratio >= PARTIAL_MATCH_MIN_RATIO) {
				if (firstMatch === undefined) firstMatch = match.index;
				matchCount++;
			}
		}
		if (matchCount > 0) {
			return { index: firstMatch, confidence: 0.94, matchCount, matchIndices, strategy: "substring" };
		}

		if (allSubstringMatches.length > 1) {
			return {
				index: allSubstringMatches[0].index,
				confidence: 0.94,
				matchCount: allSubstringMatches.length,
				matchIndices,
				strategy: "substring",
			};
		}
	}

	let bestIndex: number | undefined;
	let bestScore = 0;
	let matchCount = 0;
	const matchIndices: number[] = [];

	for (let i = startFrom; i < lines.length; i++) {
		const lineNorm = normalizeForFuzzy(lines[i]);
		const score = similarity(lineNorm, contextNorm);
		if (score >= CONTEXT_FUZZY_THRESHOLD) {
			matchCount++;
			if (matchIndices.length < 5) matchIndices.push(i);
		}
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (bestIndex !== undefined && bestScore >= CONTEXT_FUZZY_THRESHOLD) {
		return { index: bestIndex, confidence: bestScore, matchCount, matchIndices, strategy: "fuzzy" };
	}

	if (!options?.skipFunctionFallback && trimmedContext.endsWith("()")) {
		const withParen = trimmedContext.replace(/\(\)\s*$/u, "(");
		const withoutParen = trimmedContext.replace(/\(\)\s*$/u, "");
		const parenResult = findContextLine(lines, withParen, startFrom, { allowFuzzy, skipFunctionFallback: true });
		if (parenResult.index !== undefined || (parenResult.matchCount ?? 0) > 0) {
			return parenResult;
		}
		return findContextLine(lines, withoutParen, startFrom, { allowFuzzy, skipFunctionFallback: true });
	}

	return { index: undefined, confidence: bestScore };
}
