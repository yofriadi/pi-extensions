import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, parseDuration, parseMaxRetries, parseTargetTime } from "../src/config.ts";
import { DEFAULT_CONFIG, DEFAULT_MAX_RETRIES } from "../src/constants.ts";

describe("config", () => {
  describe("parseDuration", () => {
    it("parses numbers directly", () => {
      assert.equal(parseDuration(5000, 1000), 5000);
      assert.equal(parseDuration(0, 1000), 0);
    });

    it("parses duration strings", () => {
      assert.equal(parseDuration("500ms", 1000), 500);
      assert.equal(parseDuration("45s", 1000), 45000);
      assert.equal(parseDuration("30m", 1000), 1800000);
      assert.equal(parseDuration("5h", 1000), 18000000);
      assert.equal(parseDuration("1d", 1000), 86400000);
    });

    it("falls back for invalid strings or negative values", () => {
      assert.equal(parseDuration("invalid", 5000), 5000);
      assert.equal(parseDuration(-100, 5000), 5000);
      assert.equal(parseDuration(null, 5000), 5000);
      assert.equal(parseDuration(undefined, 5000), 5000);
    });
  });

  describe("parseMaxRetries", () => {
    it("parses numeric counts as attempts", () => {
      assert.deepEqual(parseMaxRetries(5), { type: "attempts", count: 5 });
      assert.deepEqual(parseMaxRetries(0), { type: "attempts", count: 0 });
      assert.deepEqual(parseMaxRetries(10.4), { type: "attempts", count: 10 });
    });

    it("parses string numbers as attempts", () => {
      assert.deepEqual(parseMaxRetries("5"), { type: "attempts", count: 5 });
      assert.deepEqual(parseMaxRetries(" 12 "), { type: "attempts", count: 12 });
      assert.deepEqual(parseMaxRetries("0"), { type: "attempts", count: 0 });
    });

    it("parses duration strings as duration deadlines", () => {
      assert.deepEqual(parseMaxRetries("15m"), { type: "duration", durationMs: 900000 });
      assert.deepEqual(parseMaxRetries("5h"), { type: "duration", durationMs: 18000000 });
      assert.deepEqual(parseMaxRetries("30s"), { type: "duration", durationMs: 30000 });
      assert.deepEqual(parseMaxRetries("500ms"), { type: "duration", durationMs: 500 });
      assert.deepEqual(parseMaxRetries("1d"), { type: "duration", durationMs: 86400000 });
    });

    it("falls back for invalid, negative, or unparseable values", () => {
      assert.deepEqual(parseMaxRetries("invalid"), { type: "attempts", count: 3 });
      assert.deepEqual(parseMaxRetries(-5), { type: "attempts", count: 3 });
      assert.deepEqual(parseMaxRetries(null), { type: "attempts", count: 3 });
      assert.deepEqual(parseMaxRetries(undefined), { type: "attempts", count: 3 });
      assert.deepEqual(
        parseMaxRetries(undefined, { type: "duration", durationMs: 60000 }),
        { type: "duration", durationMs: 60000 }
      );
    });

    it("passes through already-parsed RetryLimit objects", () => {
      const limit = { type: "attempts" as const, count: 7 };
      assert.deepEqual(parseMaxRetries(limit), limit);
    });
  });

  describe("parseTargetTime", () => {
    it("parses 24-hour HH:MM format", () => {
      const baseDate = new Date(2026, 8, 2, 12, 0, 0);
      const res = parseTargetTime("14:30", baseDate);

      assert.ok(res);
      assert.equal(res.hours, 14);
      assert.equal(res.minutes, 30);
      assert.equal(res.seconds, 0);

      const expectedDate = new Date(2026, 8, 2, 14, 30, 0);
      assert.equal(res.targetTimeMs, expectedDate.getTime());
    });

    it("parses HH:MM:SS format with seconds", () => {
      const baseDate = new Date(2026, 8, 2, 12, 0, 0);
      const res = parseTargetTime("14:30:45", baseDate);

      assert.ok(res);
      assert.equal(res.hours, 14);
      assert.equal(res.minutes, 30);
      assert.equal(res.seconds, 45);

      const expectedDate = new Date(2026, 8, 2, 14, 30, 45);
      assert.equal(res.targetTimeMs, expectedDate.getTime());
    });

    it("parses 12-hour format with AM/PM", () => {
      const baseDate = new Date(2026, 8, 2, 10, 0, 0);

      const pmRes = parseTargetTime("2:30pm", baseDate);
      assert.ok(pmRes);
      assert.equal(pmRes.hours, 14);
      assert.equal(pmRes.minutes, 30);

      const amRes = parseTargetTime("11:15 am", baseDate);
      assert.ok(amRes);
      assert.equal(amRes.hours, 11);
      assert.equal(amRes.minutes, 15);

      const midnightRes = parseTargetTime("12:00am", baseDate);
      assert.ok(midnightRes);
      assert.equal(midnightRes.hours, 0);

      const noonRes = parseTargetTime("12:30pm", baseDate);
      assert.ok(noonRes);
      assert.equal(noonRes.hours, 12);
    });

    it("rolls over to tomorrow if target time has already passed today", () => {
      const baseDate = new Date(2026, 8, 2, 15, 0, 0);
      const res = parseTargetTime("14:00", baseDate);

      assert.ok(res);
      assert.equal(res.hours, 14);
      assert.equal(res.minutes, 0);

      const expectedTomorrow = new Date(2026, 8, 3, 14, 0, 0);
      assert.equal(res.targetTimeMs, expectedTomorrow.getTime());
    });

    it("returns null for invalid strings or out-of-range values", () => {
      assert.equal(parseTargetTime("invalid"), null);
      assert.equal(parseTargetTime("25:00"), null);
      assert.equal(parseTargetTime("14:60"), null);
      assert.equal(parseTargetTime("14:30:99"), null);
      assert.equal(parseTargetTime(""), null);
      assert.equal(parseTargetTime(null), null);
      assert.equal(parseTargetTime(undefined), null);
    });
  });

  describe("loadConfig", () => {
    it("returns DEFAULT_CONFIG when file does not exist", () => {
      const config = loadConfig("/path/to/nonexistent/settings.json");
      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.equal(config.maxRetries, DEFAULT_MAX_RETRIES);
      assert.equal(config.baseDelayMs, 5000);
      assert.equal(config.maxDelayMs, 600000);
      assert.equal(config.backoffMultiplier, 2);
      assert.equal(config.rateLimit.baseDelayMs, 60000);
      assert.equal(config.rateLimit.maxDelayMs, 600000);
      assert.equal(config.rateLimit.maxRetries, "5h");
    });

    it("loads configuration from autoContinue section with global parameters and rateLimit overrides", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-test-"));
      const tmpFile = path.join(tmpDir, "settings.json");

      const settings = {
        autoContinue: {
          enabled: true,
          baseDelayMs: "10s",
          maxDelayMs: "5m",
          maxRetries: "15m",
          backoffMultiplier: 3,
          rateLimit: {
            enabled: true,
            baseDelayMs: "30s",
            maxDelayMs: "2m",
            maxRetries: 5,
            jitter: false,
            retryPrompt: "Custom rate limit prompt.",
          },
          tokenLimit: {
            continuePrompt: "Keep going please.",
          },
          incompleteToolCall: {
            continuePrompt: "Complete the tool please.",
          },
        },
      };

      fs.writeFileSync(tmpFile, JSON.stringify(settings));

      try {
        const config = loadConfig(tmpFile);
        assert.equal(config.enabled, true);
        assert.equal(config.baseDelayMs, 10000);
        assert.equal(config.maxDelayMs, 300000);
        assert.equal(config.maxRetries, "15m");
        assert.equal(config.backoffMultiplier, 3);
        assert.equal(config.rateLimit.enabled, true);
        assert.equal(config.rateLimit.baseDelayMs, 30000);
        assert.equal(config.rateLimit.maxDelayMs, 120000);
        assert.equal(config.rateLimit.jitter, false);
        assert.equal(config.rateLimit.maxRetries, 5);
        assert.equal(config.rateLimit.retryPrompt, "Custom rate limit prompt.");
        assert.equal(config.tokenLimit.continuePrompt, "Keep going please.");
        assert.equal(config.incompleteToolCall.continuePrompt, "Complete the tool please.");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("defaults rateLimit.maxRetries to 5h and rateLimit.maxDelayMs to 10m when omitted", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-test-"));
      const tmpFile = path.join(tmpDir, "settings.json");

      const settings = {
        autoContinue: {
          maxRetries: 10,
          maxDelayMs: "5m",
          rateLimit: {
            jitter: true,
          },
        },
      };

      fs.writeFileSync(tmpFile, JSON.stringify(settings));

      try {
        const config = loadConfig(tmpFile);
        assert.equal(config.maxRetries, 10);
        assert.equal(config.maxDelayMs, 300000);
        assert.equal(config.rateLimit.maxRetries, "5h");
        assert.equal(config.rateLimit.maxDelayMs, 600000);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("loads rateLimit.baseDelayMs when specified as string or number, and defaults to 1 minute when omitted or invalid", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-test-"));
      const tmpFile = path.join(tmpDir, "settings.json");

      // Case 1: rateLimit.baseDelayMs as duration string
      const settingsWithStr = {
        autoContinue: {
          baseDelayMs: "5s",
          rateLimit: {
            baseDelayMs: "15s",
          },
        },
      };
      fs.writeFileSync(tmpFile, JSON.stringify(settingsWithStr));
      try {
        const config = loadConfig(tmpFile);
        assert.equal(config.baseDelayMs, 5000);
        assert.equal(config.rateLimit.baseDelayMs, 15000);
      } finally {
        fs.rmSync(tmpFile, { force: true });
      }

      // Case 2: rateLimit.baseDelayMs as numeric ms
      const settingsWithNum = {
        autoContinue: {
          baseDelayMs: 3000,
          rateLimit: {
            baseDelayMs: 8000,
          },
        },
      };
      fs.writeFileSync(tmpFile, JSON.stringify(settingsWithNum));
      try {
        const config = loadConfig(tmpFile);
        assert.equal(config.baseDelayMs, 3000);
        assert.equal(config.rateLimit.baseDelayMs, 8000);
      } finally {
        fs.rmSync(tmpFile, { force: true });
      }

      // Case 3: rateLimit.baseDelayMs omitted (defaults to 1min = 60,000 ms, NOT global baseDelayMs of 4000)
      const settingsOmitted = {
        autoContinue: {
          baseDelayMs: 4000,
          rateLimit: {
            jitter: false,
          },
        },
      };
      fs.writeFileSync(tmpFile, JSON.stringify(settingsOmitted));
      try {
        const config = loadConfig(tmpFile);
        assert.equal(config.baseDelayMs, 4000);
        assert.equal(config.rateLimit.baseDelayMs, 60000);
      } finally {
        fs.rmSync(tmpFile, { force: true });
      }

      // Case 4: rateLimit.baseDelayMs invalid (negative or non-duration string -> defaults to 60,000 ms)
      const settingsInvalid = {
        autoContinue: {
          baseDelayMs: 5000,
          rateLimit: {
            baseDelayMs: "invalid-duration",
          },
        },
      };
      fs.writeFileSync(tmpFile, JSON.stringify(settingsInvalid));
      try {
        const config = loadConfig(tmpFile);
        assert.equal(config.baseDelayMs, 5000);
        assert.equal(config.rateLimit.baseDelayMs, 60000);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe("configuration safety regressions", () => {
  it("rejects non-finite and overflowing durations and retry limits", () => {
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE, "9".repeat(400), `${"9".repeat(400)}h`]) {
      assert.equal(parseDuration(value, 123), 123);
      assert.deepEqual(parseMaxRetries(value), { type: "attempts", count: 3 });
    }
    for (const value of [
      { type: "attempts", count: NaN },
      { type: "attempts", count: -1 },
      { type: "attempts", count: 1.5 },
      { type: "duration", durationMs: Infinity },
      { type: "duration", durationMs: -1 },
    ]) {
      assert.deepEqual(parseMaxRetries(value), { type: "attempts", count: 3 });
    }
  });

  it("rejects invalid 12-hour clock hours", () => {
    for (const value of ["00:30am", "13:30pm", "23:45 AM"]) assert.equal(parseTargetTime(value), null);
  });

  it("normalizes malformed settings and returns independent nested defaults", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-continue-config-"));
    t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const file = path.join(dir, "settings.json");
    for (const raw of [
      "{broken", "null", "[]", "true",
      '{"autoContinue":null}',
      '{"autoContinue":{"rateLimit":null,"tokenLimit":[],"incompleteToolCall":7}}',
    ]) {
      fs.writeFileSync(file, raw);
      const first = loadConfig(file);
      assert.deepEqual(first, DEFAULT_CONFIG);
      first.rateLimit.enabled = false;
      first.tokenLimit.continuePrompt = "changed";
      first.incompleteToolCall.enabled = false;
      assert.deepEqual(loadConfig(file), DEFAULT_CONFIG);
      assert.equal(DEFAULT_CONFIG.rateLimit.enabled, true);
    }
    fs.rmSync(file);
    const missing = loadConfig(file);
    missing.rateLimit.enabled = false;
    assert.equal(loadConfig(file).rateLimit.enabled, true);
  });

  it("uses defaults for blank recovery prompts instead of silently submitting nothing", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-continue-config-"));
    t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ autoContinue: {
      rateLimit: { retryPrompt: "  \n " },
      tokenLimit: { continuePrompt: "" },
      incompleteToolCall: { continuePrompt: "\t" },
    } }));
    const config = loadConfig(file);
    assert.equal(config.rateLimit.retryPrompt, DEFAULT_CONFIG.rateLimit.retryPrompt);
    assert.equal(config.tokenLimit.continuePrompt, DEFAULT_CONFIG.tokenLimit.continuePrompt);
    assert.equal(config.incompleteToolCall.continuePrompt, DEFAULT_CONFIG.incompleteToolCall.continuePrompt);
  });

  it("resolves settings from PI_CODING_AGENT_DIR without ignoring an explicit path", (t) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-continue-config-"));
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    process.env.PI_CODING_AGENT_DIR = dir;
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ autoContinue: { baseDelayMs: 1234 } }));
    const explicit = path.join(dir, "custom.json");
    fs.writeFileSync(explicit, JSON.stringify({ autoContinue: { baseDelayMs: 4567 } }));
    assert.equal(loadConfig().baseDelayMs, 1234);
    assert.equal(loadConfig(explicit).baseDelayMs, 4567);
  });

  describe("validation warnings", () => {
    const collect = (settings: unknown) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-continue-warn-"));
      const file = path.join(dir, "settings.json");
      fs.writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings));
      const warnings: string[] = [];
      try {
        return { config: loadConfig(file, (message) => warnings.push(message)), warnings };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    it("reports every value it cannot use together with the fallback it applied", () => {
      const { config, warnings } = collect({
        autoContinue: {
          enabled: 0,
          baseDelayMs: "soon",
          maxDelayMs: -5,
          backoffMultiplier: 0.5,
          maxRetries: -1,
          rateLimit: { jitter: "yes", fatalFirst: 1, windowRetryMargin: 0.9, maxRetries: "abc", retryPrompt: "   " },
          tokenLimit: { enabled: "no" },
        },
      });
      assert.equal(config.enabled, true);
      assert.equal(config.baseDelayMs, DEFAULT_CONFIG.baseDelayMs);
      assert.equal(config.maxDelayMs, DEFAULT_CONFIG.maxDelayMs);
      assert.equal(config.backoffMultiplier, DEFAULT_CONFIG.backoffMultiplier);
      assert.equal(config.maxRetries, DEFAULT_CONFIG.maxRetries);
      assert.equal(config.rateLimit.jitter, true);
      assert.equal(config.rateLimit.fatalFirst, false);
      assert.equal(config.rateLimit.windowRetryMargin, DEFAULT_CONFIG.rateLimit.windowRetryMargin);
      assert.equal(config.rateLimit.maxRetries, DEFAULT_CONFIG.rateLimit.maxRetries);
      assert.equal(config.rateLimit.retryPrompt, DEFAULT_CONFIG.rateLimit.retryPrompt);
      assert.equal(config.tokenLimit.enabled, true);
      for (const label of [
        "enabled must be true or false",
        "baseDelayMs must be a non-negative duration",
        "maxDelayMs must be a non-negative duration",
        "backoffMultiplier must be a number >= 1",
        "maxRetries must be a non-negative integer or a duration",
        "rateLimit.jitter must be true or false",
        "rateLimit.fatalFirst must be true or false",
        "rateLimit.windowRetryMargin must be a number >= 1",
        "rateLimit.maxRetries must be a non-negative integer or a duration",
        'rateLimit.retryPrompt must be a non-empty string, got "   "',
        "tokenLimit.enabled must be true or false",
      ]) {
        assert.ok(warnings.some((message) => message.includes(label)), `missing warning: ${label}\n${warnings.join("\n")}`);
      }
    });

    it("reports a typo'd key instead of ignoring it", () => {
      const { config, warnings } = collect({ autoContinue: { rateLimit: { maxRetry: "90m" } } });
      assert.equal(config.rateLimit.maxRetries, DEFAULT_CONFIG.rateLimit.maxRetries);
      assert.ok(
        warnings.some((message) => message.includes('unknown autoContinue.rateLimit setting "maxRetry"')),
        warnings.join("\n")
      );
    });

    it("reports an unreadable settings file", () => {
      const { config, warnings } = collect("{ not json");
      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.ok(warnings.some((message) => message.includes("could not load")), warnings.join("\n"));
    });

    it("reports a non-object autoContinue section", () => {
      const { config, warnings } = collect({ autoContinue: "yes" });
      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.ok(warnings.some((message) => message.includes("autoContinue must be an object")), warnings.join("\n"));
    });

    it("reports a base delay above the cap", () => {
      const { warnings } = collect({ autoContinue: { baseDelayMs: "10m", maxDelayMs: "1m" } });
      assert.ok(warnings.some((message) => message.includes("exceeds maxDelayMs")), warnings.join("\n"));
    });

    it("rejects maxRetries values that parseMaxRetries would discard", () => {
      // Accepting a string the limit parser cannot use stores a value whose
      // effective limit is a different default: "0.0" used to mean a 5h deadline.
      for (const value of ["5.5", "0.0", "99999999999999999999", "", "   ", "abc", "-1"]) {
        const { config, warnings } = collect({ autoContinue: { maxRetries: value, rateLimit: { maxRetries: value } } });
        assert.equal(config.maxRetries, DEFAULT_CONFIG.maxRetries, String(value));
        assert.equal(config.rateLimit.maxRetries, DEFAULT_CONFIG.rateLimit.maxRetries, String(value));
        assert.equal(warnings.length, 2, `${String(value)}: ${warnings.join(" | ")}`);
        assert.match(warnings[0], /must be a non-negative integer or a duration/);
      }
      const fractional = collect({ autoContinue: { maxRetries: 2.4 } });
      assert.equal(fractional.config.maxRetries, 2);
      assert.match(fractional.warnings[0], /must be an integer, got 2\.4; using 2/);
      for (const value of [0, 5, "5", "15m", "5h", "500ms", "1d"]) {
        assert.deepEqual(collect({ autoContinue: { maxRetries: value } }).warnings, [], String(value));
      }
    });

    it("reports sections and roots that are not objects", () => {
      const { config, warnings } = collect({ autoContinue: { rateLimit: 5, tokenLimit: "x", incompleteToolCall: [] } });
      assert.equal(config.rateLimit.maxRetries, DEFAULT_CONFIG.rateLimit.maxRetries);
      assert.equal(config.tokenLimit.continuePrompt, DEFAULT_CONFIG.tokenLimit.continuePrompt);
      assert.equal(warnings.filter((message) => /must be an object/.test(message)).length, 3, warnings.join(" | "));

      const root = collect(5);
      assert.deepEqual(root.config, DEFAULT_CONFIG);
      assert.ok(root.warnings.some((message) => /must contain a JSON object/.test(message)), root.warnings.join(" | "));
    });

    it("stays quiet for a valid configuration", () => {
      const { warnings } = collect({
        autoContinue: {
          enabled: true,
          subagent: false,
          baseDelayMs: "5s",
          maxDelayMs: "5m",
          backoffMultiplier: 1.5,
          maxRetries: 3,
          rateLimit: {
            enabled: true,
            baseDelayMs: "70s",
            maxDelayMs: "5m",
            maxRetries: "90m",
            jitter: true,
            fatalFirst: true,
            windowRetryMargin: 1.15,
            retryPrompt: ".",
          },
          tokenLimit: { enabled: true, continuePrompt: "Continue exactly where you stopped." },
          incompleteToolCall: { enabled: true, continuePrompt: "Re-issue that tool call." },
        },
      });
      assert.deepEqual(warnings, []);
    });
  });
});
