import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";

const testApi = (subagentsModule as any).__test__;
const safeCommentValue: (value: string) => string = testApi.safeCommentValue;

describe("safeCommentValue — shell-comment injection guard", () => {
	it("preserves a normal POSIX path unchanged", () => {
		const path = "/Users/ycm/.pi/agent/sessions/proj/2026-08-05T10-30-00Z_abc.jsonl";
		assert.equal(safeCommentValue(path), path);
	});

	it("strips LF newlines so a path cannot break out of a comment line", () => {
		const malicious = "/tmp/foo\nrm -rf /";
		const sanitized = safeCommentValue(malicious);
		assert.ok(!sanitized.includes("\n"), "LF must be removed");
		assert.equal(sanitized, "/tmp/foo rm -rf /");
		// When embedded in a `# Session: <value>` comment, the whole thing stays
		// on one inert line.
		const comment = `# Session: ${sanitized}`;
		assert.equal(comment.split("\n").length, 1);
	});

	it("strips CR and Unicode line/paragraph separators", () => {
		const values = ["foo\rbar", "foo\u2028bar", "foo\u2029bar", "foo\r\nbar"];
		for (const v of values) {
			const sanitized = safeCommentValue(v);
			assert.ok(!sanitized.includes("\r"), `CR removed for ${JSON.stringify(v)}`);
			assert.ok(!sanitized.includes("\u2028"), `U+2028 removed for ${JSON.stringify(v)}`);
			assert.ok(!sanitized.includes("\u2029"), `U+2029 removed for ${JSON.stringify(v)}`);
			assert.ok(!sanitized.includes("\n"), `LF removed for ${JSON.stringify(v)}`);
		}
	});

	it("strips C0/C1 control characters", () => {
		for (let i = 0; i <= 0x1f; i++) {
			const sanitized = safeCommentValue(`a${String.fromCharCode(i)}b`);
			assert.equal(sanitized, "a b", `control char 0x${i.toString(16)} stripped`);
		}
		assert.equal(safeCommentValue(`a\x7fb`), "a b", "DEL stripped");
	});

	it("trims leading/trailing whitespace left by stripped characters", () => {
		assert.equal(safeCommentValue("\n  /path  \n"), "/path");
	});

	it("renders a newline-bearing session path inert in a full launch preamble", () => {
		// Simulate the resume-preamble construction with a malicious realpath.
		const sessionPath = "/tmp/owned\ninject-here";
		const agentId = "test-agent";
		const id = "deadbeef";
		const surface = "w7:p1";
		const preamble = [
			`# Subagent resume script for ${safeCommentValue(agentId)}`,
			`# Run: ${safeCommentValue(id)}`,
			`# Session: ${safeCommentValue(sessionPath)}`,
			`# Surface: ${safeCommentValue(surface)}`,
		].join("\n");
		const lines = preamble.split("\n");
		// No line in the preamble may be a bare command — every line starts with `#`.
		for (const line of lines) {
			assert.ok(line.startsWith("# "), `preamble line is a comment: ${JSON.stringify(line)}`);
		}
		// The injected "inject-here" must NOT appear as its own executable line.
		assert.ok(
			!lines.some(
				(l) => l.trim() === "inject-here" || (l.trim().startsWith("inject-here") && !l.startsWith("#")),
			),
			"no bare command line leaked from the newline",
		);
	});
});
