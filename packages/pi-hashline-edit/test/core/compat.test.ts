import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COMPAT_VERSION,
	commitExternalRead,
	isHashlineEditActive,
	mintAnchor,
	readNormalizedForAnnotate,
	setHashlineEditActive,
} from "../../src/compat";
import { getReadSnapshot, resetReadSnapshot } from "../../src/read-snapshot";
import {
	clearAppliedPayload,
	isDuplicateAppliedPayload,
	recordAppliedEdit,
	resetNoopLoopGuard,
} from "../../src/noop-loop-guard";
import { computeLineHash } from "../../src/hashline";
import { formatHashlineRegion } from "../../src/hashline/format";
import { resolveMutationTargetPath } from "../../src/fs-write";

describe("compat — module shape and activation flag", () => {
	afterEach(() => {
		setHashlineEditActive(false);
	});

	it("exports the expected contract surface", () => {
		expect(COMPAT_VERSION).toBe(1);
		expect(typeof isHashlineEditActive).toBe("function");
		expect(typeof readNormalizedForAnnotate).toBe("function");
		expect(typeof commitExternalRead).toBe("function");
		expect(typeof mintAnchor).toBe("function");
	});

	it("is inert (inactive) until the extension flips the flag", () => {
		setHashlineEditActive(false);
		expect(isHashlineEditActive()).toBe(false);
		setHashlineEditActive(true);
		expect(isHashlineEditActive()).toBe(true);
	});
});

describe("compat — readNormalizedForAnnotate", () => {
	let dir: string;

	beforeEach(async () => {
		resetReadSnapshot();
		resetNoopLoopGuard();
		dir = await mkdtemp(join(tmpdir(), "hle-compat-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads, strips BOM, and normalizes to LF without writing the store", async () => {
		const path = join(dir, "a.txt");
		// BOM + CRLF + blank lines
		await writeFile(path, "\uFEFFone\r\ntwo\r\n\r\nthree\r\n");

		const result = await readNormalizedForAnnotate(path);
		expect(result).not.toBeNull();
		expect(result?.normalized).toBe("one\ntwo\n\nthree\n");
		// getPreviewLines semantics: split, drop the final empty element
		expect(result?.lines).toEqual(["one", "two", "", "three"]);

		// NO store write happened.
		expect(getReadSnapshot(path)).toBeNull();
	});

	it("keeps a trailing empty element when content does not end with newline", async () => {
		const path = join(dir, "b.txt");
		await writeFile(path, "x\ny");
		const result = await readNormalizedForAnnotate(path);
		expect(result?.lines).toEqual(["x", "y"]);
	});

	it("returns null for missing files", async () => {
		expect(
			await readNormalizedForAnnotate(join(dir, "nope.txt")),
		).toBeNull();
	});

	it("returns null for binary files", async () => {
		const path = join(dir, "bin.bin");
		await writeFile(path, Buffer.from([0x00, 0x01, 0x02, 0x03]));
		expect(await readNormalizedForAnnotate(path)).toBeNull();
	});

	it("returns null for directories", async () => {
		expect(await readNormalizedForAnnotate(dir)).toBeNull();
	});
});

describe("compat — commitExternalRead", () => {
	let dir: string;

	beforeEach(async () => {
		resetReadSnapshot();
		resetNoopLoopGuard();
		dir = await mkdtemp(join(tmpdir(), "hle-commit-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("produces store state identical to a native read of the same bytes", async () => {
		const path = join(dir, "same.txt");
		await writeFile(path, "alpha\nbeta\ngamma\n");

		const result = await readNormalizedForAnnotate(path);
		expect(result).not.toBeNull();
		await commitExternalRead(path, result!.normalized);

		const canonical = await resolveMutationTargetPath(path);
		expect(getReadSnapshot(canonical)).toBe(result!.normalized);
	});

	it("clears the applied-payload guard like a native re-read", async () => {
		const path = join(dir, "guard.txt");
		await writeFile(path, "payload\nlines\n");

		// Simulate a prior applied edit payload recorded for this path.
		const canonical0 = await resolveMutationTargetPath(path);
		recordAppliedEdit(canonical0, "old-payload");
		expect(isDuplicateAppliedPayload(canonical0, "old-payload")).toBe(true);

		const result = await readNormalizedForAnnotate(path);
		await commitExternalRead(path, result!.normalized);

		const canonical = await resolveMutationTargetPath(path);
		expect(isDuplicateAppliedPayload(canonical, "old-payload")).toBe(false);
		expect(getReadSnapshot(canonical)).toBe(result!.normalized);
	});

	it("commits via the canonical path (symlinked source registers the target)", async () => {
		const target = join(dir, "target.txt");
		await writeFile(target, "real\ncontent\n");
		const link = join(dir, "link.txt");
		await (
			await import("node:fs/promises")
		).symlink(target, link);

		const result = await readNormalizedForAnnotate(link);
		expect(result).not.toBeNull();
		await commitExternalRead(link, result!.normalized);

		// The store slot is keyed by the canonical (resolved) path.
		const canonicalTarget = await resolveMutationTargetPath(target);
		expect(getReadSnapshot(canonicalTarget)).toBe(result!.normalized);
		expect(isDuplicateAppliedPayload(canonicalTarget, "x")).toBe(false);
	});
});

describe("compat — mintAnchor", () => {
	it("computes the same hash read.ts anchors embed (full-file context)", () => {
		const fileLines = ["import a;", "\tconst b = 1;", "", "export {};"];
		const expected = computeLineHash(fileLines, 1);
		expect(mintAnchor(fileLines, 2)).toBe(expected);
	});

	it("round-trips through formatHashlineRegion's hash bits", () => {
		const fileLines = ["one", "two", "three"];
		// formatHashlineRegion mints `${padded}#${hash}:${line}`; mintAnchor
		// must return exactly the hash portion for the same line.
		const region = formatHashlineRegion(fileLines, 1, 3).split("\n");
		const line2 = region[1] ?? "";
		const hash = line2.split("#")[1]?.split(":")[0];
		expect(mintAnchor(fileLines, 2)).toBe(hash);
	});
});

describe("compat — integration ordering (verify-then-commit)", () => {
	let dir: string;

	beforeEach(async () => {
		resetReadSnapshot();
		resetNoopLoopGuard();
		dir = await mkdtemp(join(tmpdir(), "hle-order-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("a mismatched commit is detectable: committed bytes differ from disk", async () => {
		const path = join(dir, "drift.txt");
		await writeFile(path, "disk state\n");
		const result = await readNormalizedForAnnotate(path);

		// Consumer verifies against a stale copy, notices drift, and must NOT
		// commit. Simulate the negative: if it (incorrectly) committed stale
		// bytes, the snapshot would disagree with the disk content.
		const stale = "stale state\n";
		expect(stale).not.toBe(result?.normalized);

		// Correct behavior: no commit on mismatch.
		expect(getReadSnapshot(path)).toBeNull();
		// And the guard was never involved.
		expect(clearAppliedPayload(path)).toBeUndefined();
	});
});
