import type { DiffHunk, FileDiff, FileHunks, HunkSelector } from "./types.js";

export function parseFileDiffs(diff: string): FileDiff[] {
	const sections: FileDiff[] = [];
	const parts = diff.split("\ndiff --git ");

	for (let index = 0; index < parts.length; index += 1) {
		const part = index === 0 ? parts[index] : `diff --git ${parts[index]}`;
		if (!part?.trim()) {
			continue;
		}

		const lines = part.split("\n");
		const header = lines[0] ?? "";
		const match = header.match(/diff --git a\/(.+?) b\/(.+)$/);
		if (!match) {
			continue;
		}

		const filename = match[2] ?? match[1] ?? "";
		if (!filename) {
			continue;
		}

		const isBinary = lines.some((line) => line.startsWith("Binary files "));
		let additions = 0;
		let deletions = 0;
		for (const line of lines) {
			if (line.startsWith("+++ ") || line.startsWith("--- ")) {
				continue;
			}
			if (line.startsWith("+")) {
				additions += 1;
			} else if (line.startsWith("-")) {
				deletions += 1;
			}
		}

		sections.push({
			filename,
			content: part,
			additions,
			deletions,
			isBinary,
		});
	}

	return sections;
}

export function parseDiffHunks(diff: string): FileHunks[] {
	return parseFileDiffs(diff).map((fileDiff) => parseFileHunks(fileDiff));
}

export function parseFileHunks(fileDiff: FileDiff): FileHunks {
	if (fileDiff.isBinary) {
		return { filename: fileDiff.filename, isBinary: true, hunks: [] };
	}

	const lines = fileDiff.content.split("\n");
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | null = null;
	let buffer: string[] = [];
	let index = 0;

	for (const line of lines) {
		if (line.startsWith("@@")) {
			if (current) {
				current.content = buffer.join("\n");
				hunks.push(current);
			}

			const parsed = parseHunkHeader(line);
			current = {
				index,
				header: line,
				oldStart: parsed.oldStart,
				oldLines: parsed.oldLines,
				newStart: parsed.newStart,
				newLines: parsed.newLines,
				content: "",
			};
			buffer = [line];
			index += 1;
			continue;
		}

		if (current) {
			buffer.push(line);
		}
	}

	if (current) {
		current.content = buffer.join("\n");
		hunks.push(current);
	}

	return {
		filename: fileDiff.filename,
		isBinary: fileDiff.isBinary,
		hunks,
	};
}

export function extractFileHeader(fileDiffText: string): string {
	const lines = fileDiffText.split("\n");
	const headerLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("@@")) {
			break;
		}
		headerLines.push(line);
	}
	return headerLines.join("\n");
}

export function selectHunks(fileDiff: FileDiff, selector: HunkSelector): DiffHunk[] {
	const fileHunks = parseFileHunks(fileDiff);
	if (selector.type === "all") {
		return fileHunks.hunks;
	}

	if (selector.type === "indices") {
		const wanted = new Set(selector.indices.map((value) => Math.max(1, Math.floor(value))));
		return fileHunks.hunks.filter((hunk) => wanted.has(hunk.index + 1));
	}

	const start = Math.floor(selector.start);
	const end = Math.floor(selector.end);
	return fileHunks.hunks.filter(
		(hunk) => hunk.newStart <= end && hunk.newStart + Math.max(1, hunk.newLines) - 1 >= start,
	);
}

export function summarizeHunksForPrompt(diff: string, maxFiles = 80, maxHunksPerFile = 8): string {
	const files = parseDiffHunks(diff);
	const summary = files.slice(0, maxFiles).map((file) => ({
		path: file.filename,
		isBinary: file.isBinary,
		hunks: file.hunks.slice(0, maxHunksPerFile).map((hunk) => ({
			index: hunk.index + 1,
			header: hunk.header,
			preview: hunk.content
				.split("\n")
				.filter((line) => line.startsWith("+") || line.startsWith("-"))
				.slice(0, 3),
		})),
	}));

	return JSON.stringify(summary, null, 2);
}

function parseHunkHeader(line: string): {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
} {
	const match = line.match(/@@\s-([0-9]+)(?:,([0-9]+))?\s\+([0-9]+)(?:,([0-9]+))?\s@@/);
	if (!match) {
		return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 };
	}

	const oldStart = Number.parseInt(match[1] ?? "0", 10);
	const oldLines = Number.parseInt(match[2] ?? "1", 10);
	const newStart = Number.parseInt(match[3] ?? "0", 10);
	const newLines = Number.parseInt(match[4] ?? "1", 10);

	return {
		oldStart: Number.isNaN(oldStart) ? 0 : oldStart,
		oldLines: Number.isNaN(oldLines) ? 0 : oldLines,
		newStart: Number.isNaN(newStart) ? 0 : newStart,
		newLines: Number.isNaN(newLines) ? 0 : newLines,
	};
}
