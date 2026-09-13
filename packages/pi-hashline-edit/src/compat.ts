/**
 * External verify-then-commit contract for pi-tilth (and future consumers).
 *
 * This module is deliberately import-light: it re-uses read/edit internals
 * (canonicalization, normalization, snapshot store, hash minting) without
 * registering tools or prompting. A consumer that saw file content through
 * some other transport (e.g. tilth via mcporter) can register exactly the
 * bytes it verified, so edits against hashline anchors work regardless of
 * which read surface produced them.
 *
 * Contract (versioned by COMPAT_VERSION):
 *  - `readNormalizedForAnnotate(path)`: read + canonicalize +
 *    stripBom + normalizeToLF. NO snapshot-store write. Returns null on any
 *    failure (missing file, binary file, decode problems) so callers can
 *    fall back to passthrough.
 *  - `commitExternalRead(path, normalized)`: register exactly the bytes that
 *    were verified — same store semantics as a native read.ts read of the
 *    same content: rememberReadSnapshot + clearAppliedPayload on the
 *    canonical path.
 *  - `mintAnchor(fileLines, line1)`: compute the line hash for a 1-based line
 *    number with full-file context, identical to what read.ts anchors embed.
 */
import { normalizeToLF, stripBom } from "./edit-diff";
import { loadFileKindAndText } from "./file-kind";
import { resolveMutationTargetPath } from "./fs-write";
import { computeLineHash } from "./hashline";
import { clearAppliedPayload } from "./noop-loop-guard";
import { rememberReadSnapshot } from "./read-snapshot";

export const COMPAT_VERSION = 1;

let active = false;

/** Called by index.ts at extension load — compat is inert until then. */
export function setHashlineEditActive(value: boolean): void {
	active = value;
}

export function isHashlineEditActive(): boolean {
	return active;
}

/**
 * Read a file exactly the way read.ts does, minus the store write.
 * Returns null when the path cannot be read as text.
 */
export async function readNormalizedForAnnotate(
	path: string,
): Promise<{ normalized: string; lines: string[] } | null> {
	try {
		const canonical = await resolveMutationTargetPath(path);
		const file = await loadFileKindAndText(canonical);
		if (file.kind !== "text") return null;
		if (file.hadUtf8DecodeErrors) return null;

		const normalized = normalizeToLF(stripBom(file.text).text);
		// Same line-splitting semantics as read.ts previews and
		// formatHashlineRegion: split("\n") with the final empty element
		// dropped when content ends with a newline.
		const split = normalized.split("\n");
		const lines = normalized.endsWith("\n") ? split.slice(0, -1) : split;
		return { normalized, lines };
	} catch {
		return null;
	}
}

/**
 * Register externally-verified bytes into the read snapshot store.
 * `normalized` must be the exact string readNormalizedForAnnotate returned
 * for this file (the caller has byte-verified it against what it displayed).
 * Mirrors the store semantics of a native read: snapshot + loop-guard reset
 * on the canonical path.
 */
export async function commitExternalRead(
	path: string,
	normalized: string,
): Promise<void> {
	const canonical = await resolveMutationTargetPath(path);
	rememberReadSnapshot(canonical, normalized);
	clearAppliedPayload(canonical);
}

/**
 * Mint the `NN#HASH:content` hash portion for a 1-based line number using
 * full-file context — identical to what read.ts anchors embed for that line.
 */
export function mintAnchor(fileLines: string[], line1: number): string {
	return computeLineHash(fileLines, line1 - 1);
}
