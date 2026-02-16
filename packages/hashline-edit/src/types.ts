/**
 * Shared types for hashline module.
 */

/** A single hash mismatch found during validation */
export interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

/** Hashline edit operation types */
export type HashlineSetLine = {
	set_line: {
		anchor: string;
		new_text: string;
	};
};

export type HashlineReplaceLines = {
	replace_lines: {
		start_anchor: string;
		end_anchor?: string;
		new_text: string;
	};
};

export type HashlineInsertAfter = {
	insert_after: {
		anchor: string;
		text: string;
	};
};

export type HashlineReplace = {
	replace: {
		old_text: string;
		new_text: string;
		all?: boolean;
	};
};

export type HashlineEdit = HashlineSetLine | HashlineReplaceLines | HashlineInsertAfter | HashlineReplace;

/** Result of applying hashline edits */
export interface HashlineApplyResult {
	content: string;
	firstChangedLine?: number;
	warnings?: string[];
	noopEdits?: Array<{
		editIndex: number;
		loc: string;
		currentContent: string;
	}>;
}

/** Error class for hashline mismatches */
export class HashlineMismatchError extends Error {
	constructor(
		public readonly mismatches: HashMismatch[],
		public readonly fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";
	}

	static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const lines = ["Hash mismatch detected. File content has changed since last read."];
		lines.push("");
		lines.push("Updated line references:");
		for (const m of mismatches.slice(0, 10)) {
			const content = fileLines[m.line - 1] ?? "";
			const preview = content.length > 60 ? `${content.slice(0, 57)}...` : content;
			lines.push(`>>> ${m.line}:${m.actual}|${preview}`);
		}
		if (mismatches.length > 10) {
			lines.push(`... and ${mismatches.length - 10} more`);
		}
		return lines.join("\n");
	}
}
