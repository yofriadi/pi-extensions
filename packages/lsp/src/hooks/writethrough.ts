import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import type { LspRuntimeRegistry } from "../client/registry.js";
import type { LspDiagnostic } from "../client/runtime.js";

interface LspPosition {
	line: number;
	character: number;
}

interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

interface LspTextEdit {
	range: LspRange;
	newText: string;
}

export interface WriteThroughHooks {
	register(pi: ExtensionAPI): void;
}

export interface WriteThroughOptions {
	cwd?: string;
	formatOnWrite?: boolean;
	diagnosticsOnWrite?: boolean;
	formattingOptions?: {
		tabSize?: number;
		insertSpaces?: boolean;
	};
}

export function createWriteThroughHooks(
	runtime: LspRuntimeRegistry,
	options: WriteThroughOptions = {},
): WriteThroughHooks {
	const cwd = options.cwd ?? process.cwd();
	const formatOnWrite = options.formatOnWrite ?? true;
	const diagnosticsOnWrite = options.diagnosticsOnWrite ?? true;
	const formattingOptions = {
		tabSize: options.formattingOptions?.tabSize ?? 2,
		insertSpaces: options.formattingOptions?.insertSpaces ?? true,
	};

	return {
		register(pi: ExtensionAPI): void {
			pi.on("tool_result", async (event, ctx) => {
				await maybeHandleWriteThrough(event, ctx);
			});
		},
	};

	async function maybeHandleWriteThrough(event: ToolResultEvent, ctx: ExtensionContext): Promise<void> {
		if (event.isError) {
			return;
		}
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return;
		}

		const filePath = getToolInputPath(event.input);
		if (!filePath) {
			return;
		}

		const pathStatus = runtime.getStatusForPath(filePath);
		if (!pathStatus || pathStatus.state !== "ready") {
			ctx.ui.notify(
				`LSP write-through skipped for ${filePath}: ${pathStatus ? pathStatus.reason : "no matching server"}.`,
				"warning",
			);
			return;
		}

		const uri = pathToFileURL(resolve(cwd, filePath)).href;
		const summaries: string[] = [];

		if (formatOnWrite) {
			try {
				const rawEdits = await runtime.request(
					"textDocument/formatting",
					{
						textDocument: { uri },
						options: formattingOptions,
					},
					{ path: filePath },
				);
				const edits = normalizeTextEdits(rawEdits);
				const applied = await applyFormattingEdits(filePath, edits, cwd);
				summaries.push(applied > 0 ? `formatted (${applied} edits)` : "no formatting changes");
			} catch (error) {
				summaries.push(`format failed: ${toErrorMessage(error)}`);
			}
		}

		if (diagnosticsOnWrite) {
			try {
				const diagnosticPayload = await runtime.request(
					"textDocument/diagnostic",
					{
						textDocument: { uri },
					},
					{ path: filePath },
				);
				const diagnostics = extractDiagnostics(diagnosticPayload, runtime.getPublishedDiagnostics(filePath));
				summaries.push(summarizeDiagnostics(diagnostics));
			} catch {
				const fallbackDiagnostics = runtime.getPublishedDiagnostics(filePath);
				summaries.push(summarizeDiagnostics(fallbackDiagnostics));
			}
		}

		if (summaries.length > 0) {
			ctx.ui.notify(`LSP write-through ${filePath}: ${summaries.join("; ")}`, "info");
		}
	}
}

function getToolInputPath(input: Record<string, unknown>): string | undefined {
	const value = input.path;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeTextEdits(raw: unknown): LspTextEdit[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const edits: LspTextEdit[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const edit = entry as Record<string, unknown>;
		if (typeof edit.newText !== "string") {
			continue;
		}
		const range = normalizeRange(edit.range);
		if (!range) {
			continue;
		}
		edits.push({ range, newText: edit.newText });
	}
	return edits;
}

function normalizeRange(raw: unknown): LspRange | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const start = normalizePosition(record.start);
	const end = normalizePosition(record.end);
	if (!start || !end) {
		return undefined;
	}
	return { start, end };
}

function normalizePosition(raw: unknown): LspPosition | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	if (typeof record.line !== "number" || typeof record.character !== "number") {
		return undefined;
	}
	return {
		line: record.line,
		character: record.character,
	};
}

async function applyFormattingEdits(filePath: string, edits: LspTextEdit[], cwd: string): Promise<number> {
	if (edits.length === 0) {
		return 0;
	}

	const fullPath = resolve(cwd, filePath);
	const originalText = await fsReadFile(fullPath, "utf8");
	const nextText = applyTextEdits(originalText, edits);
	if (nextText === originalText) {
		return 0;
	}

	await fsWriteFile(fullPath, nextText, "utf8");
	return edits.length;
}

function applyTextEdits(text: string, edits: LspTextEdit[]): string {
	const lineStarts = computeLineStarts(text);
	const normalized = edits
		.map((edit) => {
			const start = positionToOffset(lineStarts, text.length, edit.range.start);
			const end = positionToOffset(lineStarts, text.length, edit.range.end);
			return {
				start,
				end,
				newText: edit.newText,
			};
		})
		.filter((edit) => edit.start <= edit.end)
		.sort((left, right) => {
			if (left.start !== right.start) {
				return right.start - left.start;
			}
			return right.end - left.end;
		});

	if (normalized.length === 0) {
		return text;
	}

	const parts: string[] = [];
	let cursor = text.length;
	for (const edit of normalized) {
		if (edit.end > cursor) {
			// Defensive fallback for malformed/overlapping edit ranges.
			let output = text;
			for (const fallbackEdit of normalized) {
				output = `${output.slice(0, fallbackEdit.start)}${fallbackEdit.newText}${output.slice(fallbackEdit.end)}`;
			}
			return output;
		}

		parts.push(text.slice(edit.end, cursor));
		parts.push(edit.newText);
		cursor = edit.start;
	}
	parts.push(text.slice(0, cursor));
	return parts.reverse().join("");
}

function computeLineStarts(text: string): number[] {
	const lineStarts = [0];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\n") {
			lineStarts.push(index + 1);
		}
	}
	return lineStarts;
}

function positionToOffset(lineStarts: number[], textLength: number, position: LspPosition): number {
	const safeLine = Math.max(0, position.line);
	const safeChar = Math.max(0, position.character);
	const lineStart = safeLine < lineStarts.length ? lineStarts[safeLine] : textLength;
	return Math.min(textLength, lineStart + safeChar);
}

function extractDiagnostics(payload: unknown, fallback: LspDiagnostic[]): LspDiagnostic[] {
	if (!payload || typeof payload !== "object") {
		return fallback;
	}

	const record = payload as Record<string, unknown>;
	if (!Array.isArray(record.items)) {
		return fallback;
	}

	const diagnostics: LspDiagnostic[] = [];
	for (const item of record.items) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const diagnostic = item as Record<string, unknown>;
		if (typeof diagnostic.message !== "string") {
			continue;
		}
		const range = normalizeRange(diagnostic.range);
		if (!range) {
			continue;
		}

		diagnostics.push({
			range,
			message: diagnostic.message,
			severity: typeof diagnostic.severity === "number" ? diagnostic.severity : undefined,
			source: typeof diagnostic.source === "string" ? diagnostic.source : undefined,
			code: typeof diagnostic.code === "string" || typeof diagnostic.code === "number" ? diagnostic.code : undefined,
		});
	}

	return diagnostics.length > 0 ? diagnostics : fallback;
}

function summarizeDiagnostics(diagnostics: LspDiagnostic[]): string {
	if (diagnostics.length === 0) {
		return "no diagnostics";
	}

	let errors = 0;
	let warnings = 0;
	let infos = 0;
	for (const diagnostic of diagnostics) {
		switch (diagnostic.severity) {
			case 1:
				errors += 1;
				break;
			case 2:
				warnings += 1;
				break;
			default:
				infos += 1;
				break;
		}
	}

	const parts = [`${diagnostics.length} diagnostics`];
	if (errors > 0) parts.push(`${errors} errors`);
	if (warnings > 0) parts.push(`${warnings} warnings`);
	if (infos > 0) parts.push(`${infos} info`);
	return parts.join(", ");
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
