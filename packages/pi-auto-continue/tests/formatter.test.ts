import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDateTime,
  formatDelay,
  formatDuration,
  formatMaxRetries,
  formatTime,
  truncateErrorMessage,
} from "../src/formatter.ts";

describe("formatter", () => {
  describe("formatDuration", () => {
    it("formats seconds correctly", () => {
      assert.equal(formatDuration(0), "0s");
      assert.equal(formatDuration(5000), "5s");
      assert.equal(formatDuration(45000), "45s");
    });

    it("formats minutes correctly", () => {
      assert.equal(formatDuration(60000), "1m");
      assert.equal(formatDuration(90000), "1m 30s");
      assert.equal(formatDuration(185000), "3m 5s");
    });

    it("formats hours correctly", () => {
      assert.equal(formatDuration(3600000), "1h");
      assert.equal(formatDuration(5400000), "1h 30m");
      assert.equal(formatDuration(5 * 60 * 60 * 1000), "5h");
      assert.equal(formatDuration(5 * 60 * 60 * 1000 + 15 * 60 * 1000), "5h 15m");
    });

    it("handles negative durations safely", () => {
      assert.equal(formatDuration(-1000), "0s");
    });
  });

  describe("formatDelay", () => {
    it("formats milliseconds", () => {
      assert.equal(formatDelay(500), "500ms");
    });

    it("formats seconds", () => {
      assert.equal(formatDelay(5000), "5s");
      assert.equal(formatDelay(12500), "12.5s");
    });

    it("formats minutes", () => {
      assert.equal(formatDelay(60000), "1m");
      assert.equal(formatDelay(90000), "1.5m");
    });

    it("formats hours", () => {
      assert.equal(formatDelay(3600000), "1h");
      assert.equal(formatDelay(7200000), "2h");
    });
  });

  describe("truncateErrorMessage", () => {
    it("handles empty or missing strings", () => {
      assert.equal(truncateErrorMessage(undefined), "Unknown error");
      assert.equal(truncateErrorMessage(""), "Unknown error");
    });

    it("normalizes newlines and spaces", () => {
      const multiline = "Error on line 1\n   Error on line 2\r\n\tDetails";
      assert.equal(truncateErrorMessage(multiline), "Error on line 1 Error on line 2 Details");
    });

    it("truncates long strings cleanly", () => {
      const long = "A".repeat(200);
      const truncated = truncateErrorMessage(long, 50);
      assert.equal(truncated.length, 50);
      assert.ok(truncated.endsWith("..."));
    });
  });

  describe("formatTime", () => {
    it("formats local time to HH:MM:SS format", () => {
      const date = new Date(2026, 8, 2, 14, 5, 9);
      assert.equal(formatTime(date), "14:05:09");
    });

    it("formats milliseconds timestamp with padding", () => {
      const date = new Date(2026, 8, 2, 9, 1, 2);
      assert.equal(formatTime(date.getTime()), "09:01:02");
    });
  });

  describe("formatDateTime", () => {
    // Derived from Intl rather than from getTimezoneOffset arithmetic, so a sign,
    // padding or rounding bug in utcOffsetLabel cannot be mirrored by the
    // expectation and both exact-string tests stay load-bearing.
    const zone = (date: Date): string => {
      const name = new Intl.DateTimeFormat("en-US", { timeZoneName: "longOffset" })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value ?? "";
      // ICU renders a zero offset as "GMT+00:00" here and older ECMA-402 said bare
      // "GMT", while utcOffsetLabel prints "UTC" either way -- so both zero forms
      // are folded explicitly or the suite is red under TZ=UTC (what CI runs).
      const offset = name.replace(/^GMT/, "");
      return offset === "" || offset === "+00:00" || offset === "-00:00" ? "UTC" : `UTC${offset}`;
    };

    it("formats local date and time to YYYY-MM-DD HH:MM:SS with a zone label", () => {
      const date = new Date(2026, 8, 2, 14, 5, 9);
      assert.equal(formatDateTime(date), `2026-09-02 14:05:09 (${zone(date)})`);
    });

    it("handles zero-padded single-digit months, days, hours, mins, secs", () => {
      const date = new Date(2026, 0, 5, 8, 4, 3);
      assert.equal(formatDateTime(date), `2026-01-05 08:04:03 (${zone(date)})`);
    });

    it("labels a zone that reconciles the local rendering with the instant", () => {
      // The rendered time is local, so the label is the only thing that stops
      // "Expected token reset time: 2026-09-21 04:43:12" being read as UTC.
      const instant = Date.UTC(2026, 8, 2, 12, 0, 0);
      const rendered = formatDateTime(instant);
      const label = rendered.match(/\((UTC(?:[+-]\d{2}:\d{2})?)\)$/);
      assert.ok(label, rendered);
      const [hours, minutes] = label[1] === "UTC"
        ? [0, 0]
        : label[1].slice(4).split(":").map((part) => Number(part));
      const offsetMinutes = (label[1][3] === "-" ? -1 : 1) * (hours * 60 + minutes);
      const asUtc = new Date(instant + offsetMinutes * 60000).toISOString().slice(0, 19).replace("T", " ");
      assert.equal(rendered.slice(0, 19), asUtc);
    });
  });

  describe("formatMaxRetries", () => {
    it("formats attempts count limit", () => {
      assert.equal(formatMaxRetries(3), "3 attempt(s)");
      assert.equal(formatMaxRetries("5"), "5 attempt(s)");
      assert.equal(formatMaxRetries({ type: "attempts", count: 10 }), "10 attempt(s)");
    });

    it("formats duration deadline limit", () => {
      assert.equal(formatMaxRetries("15m"), "15m (900000 ms)");
      assert.equal(formatMaxRetries("5h"), "5h (18000000 ms)");
      assert.equal(formatMaxRetries({ type: "duration", durationMs: 60000 }), "1m (60000 ms)");
    });
  });
});
