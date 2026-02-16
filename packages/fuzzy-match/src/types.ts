/**
 * Shared types for fuzzy matching module.
 */

/** Result of a fuzzy match operation */
export interface FuzzyMatch {
	actualText: string;
	startIndex: number;
	startLine: number;
	confidence: number;
}

/** Outcome of attempting to find a match */
export interface MatchOutcome {
	match?: FuzzyMatch;
	closest?: FuzzyMatch;
	occurrences?: number;
	occurrenceLines?: number[];
	occurrencePreviews?: string[];
	fuzzyMatches?: number;
	dominantFuzzy?: boolean;
}

/** Result of a sequence search */
export type SequenceMatchStrategy =
	| "exact"
	| "trim-trailing"
	| "trim"
	| "comment-prefix"
	| "unicode"
	| "prefix"
	| "substring"
	| "fuzzy"
	| "fuzzy-dominant"
	| "character";

export interface SequenceSearchResult {
	index: number | undefined;
	confidence: number;
	matchCount?: number;
	matchIndices?: number[];
	strategy?: SequenceMatchStrategy;
}

/** Result of a context line search */
export type ContextMatchStrategy = "exact" | "trim" | "unicode" | "prefix" | "substring" | "fuzzy";

export interface ContextLineResult {
	index: number | undefined;
	confidence: number;
	matchCount?: number;
	matchIndices?: number[];
	strategy?: ContextMatchStrategy;
}

/** Error class for edit match failures */
export class EditMatchError extends Error {
	constructor(
		public readonly path: string,
		public readonly searchText: string,
		public readonly closest: FuzzyMatch | undefined,
		public readonly options: { allowFuzzy: boolean; threshold: number; fuzzyMatches?: number },
	) {
		super(EditMatchError.formatMessage(path, searchText, closest, options));
		this.name = "EditMatchError";
	}

	static formatMessage(
		path: string,
		searchText: string,
		closest: FuzzyMatch | undefined,
		options: { allowFuzzy: boolean; threshold: number; fuzzyMatches?: number },
	): string {
		if (!closest) {
			return options.allowFuzzy
				? `Could not find a close enough match in ${path}.`
				: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;
		}

		const similarity = Math.round(closest.confidence * 100);
		const searchLines = searchText.split("\n");
		const actualLines = closest.actualText.split("\n");
		const { oldLine, newLine } = findFirstDifferentLine(searchLines, actualLines);
		const thresholdPercent = Math.round(options.threshold * 100);

		const hint = options.allowFuzzy
			? options.fuzzyMatches && options.fuzzyMatches > 1
				? `Found ${options.fuzzyMatches} high-confidence matches. Provide more context to make it unique.`
				: `Closest match was below the ${thresholdPercent}% similarity threshold.`
			: "Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept high-confidence matches.";

		return [
			options.allowFuzzy
				? `Could not find a close enough match in ${path}.`
				: `Could not find the exact text in ${path}.`,
			``,
			`Closest match (${similarity}% similar) at line ${closest.startLine}:`,
			`  - ${oldLine}`,
			`  + ${newLine}`,
			hint,
		].join("\n");
	}
}

function findFirstDifferentLine(oldLines: string[], newLines: string[]): { oldLine: string; newLine: string } {
	const max = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < max; i++) {
		const oldLine = oldLines[i] ?? "";
		const newLine = newLines[i] ?? "";
		if (oldLine !== newLine) {
			return { oldLine, newLine };
		}
	}
	return { oldLine: oldLines[0] ?? "", newLine: newLines[0] ?? "" };
}
