import { describe, expect, it } from "vitest";
import { isValidRefArg } from "../src/git.js";

describe("git ref arg validation", () => {
	it("accepts normal refs", () => {
		expect(isValidRefArg("main")).toBe(true);
		expect(isValidRefArg("feature/my-branch")).toBe(true);
		expect(isValidRefArg("abc1234")).toBe(true);
	});

	it("rejects suspicious refs", () => {
		expect(isValidRefArg("--help")).toBe(false);
		expect(isValidRefArg("bad ref")).toBe(false);
		expect(isValidRefArg(" ")).toBe(false);
	});
});
