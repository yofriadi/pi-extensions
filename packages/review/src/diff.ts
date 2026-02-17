import type { DiffStats } from "./types.js";

const EXCLUDED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /(^|\/)package-lock\.json$/, reason: "lock file" },
	{ pattern: /(^|\/)pnpm-lock\.ya?ml$/, reason: "lock file" },
	{ pattern: /(^|\/)yarn\.lock$/, reason: "lock file" },
	{ pattern: /(^|\/)Cargo\.lock$/, reason: "lock file" },
	{ pattern: /(^|\/)bun\.lockb?$/, reason: "lock file" },
	{ pattern: /\.lock$/i, reason: "lock file" },
	{ pattern: /\.min\.(js|css)$/i, reason: "minified" },
	{ pattern: /\.generated\./i, reason: "generated" },
	{ pattern: /\.snap$/i, reason: "snapshot" },
	{ pattern: /\.map$/i, reason: "source map" },
	{ pattern: /(^|\/)dist\//, reason: "build output" },
	{ pattern: /(^|\/)build\//, reason: "build output" },
	{ pattern: /(^|\/)out\//, reason: "build output" },
	{ pattern: /(^|\/)node_modules\//, reason: "vendor" },
	{ pattern: /(^|\/)vendor\//, reason: "vendor" },
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif|svg)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

const MAX_PREVIEW_LINES_PER_FILE = 120;

function getExclusionReason(path: string): string | undefined {
	for (const { pattern, reason } of EXCLUDED_PATTERNS) {
		if (pattern.test(path)) {
			return reason;
		}
	}
	return undefined;
}

function isMetadataLine(line: string): boolean {
	return (
		/^a\/.* b\/.*/.test(line) ||
		line.startsWith("diff --git") ||
		line.startsWith("index ") ||
		line.startsWith("---") ||
		line.startsWith("+++") ||
		line.startsWith("@@")
	);
}

function buildPreview(lines: string[]): string {
	const preview: string[] = [];
	for (const line of lines) {
		if (isMetadataLine(line)) {
			continue;
		}
		preview.push(line);
		if (preview.length >= MAX_PREVIEW_LINES_PER_FILE) {
			break;
		}
	}
	return preview.join("\n");
}

export function parseDiff(diffOutput: string): DiffStats {
	const files: DiffStats["files"] = [];
	const excluded: DiffStats["excluded"] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);

	for (const chunk of fileChunks) {
		const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
		if (!headerMatch) {
			continue;
		}

		const path = headerMatch[2];
		let linesAdded = 0;
		let linesRemoved = 0;
		const lines = chunk.split("\n");

		for (const line of lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				linesAdded++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				linesRemoved++;
			}
		}

		const reason = getExclusionReason(path);
		if (reason) {
			excluded.push({ path, reason, linesAdded, linesRemoved });
			continue;
		}

		files.push({
			path,
			linesAdded,
			linesRemoved,
			preview: buildPreview(lines),
		});
		totalAdded += linesAdded;
		totalRemoved += linesRemoved;
	}

	return { files, excluded, totalAdded, totalRemoved };
}

export function truncatePreview(preview: string, maxLines: number): string {
	if (maxLines <= 0) {
		return "";
	}
	return preview.split("\n").slice(0, maxLines).join("\n");
}

export function getFileExt(path: string): string {
	const match = path.match(/\.([^./]+)$/);
	return match ? match[1] : "";
}
