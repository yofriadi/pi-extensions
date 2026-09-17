import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetWarmBashParser,
  warmBashParser,
} from "#src/access-intent/bash/parser";
import {
  maskCommandFields,
  redactCommandSecrets,
} from "#src/logging/command-redaction";
import { REDACTED_PLACEHOLDER } from "#src/logging/log-redaction";

const MASK = REDACTED_PLACEHOLDER;

describe("redactCommandSecrets", () => {
  afterEach(() => {
    resetWarmBashParser();
  });

  describe("once the parser is warm", () => {
    beforeEach(async () => {
      resetWarmBashParser();
      await warmBashParser();
    });

    describe("a shell assignment whose name is sensitive", () => {
      it("masks a quoted env-prefix value", () => {
        expect(redactCommandSecrets('KEY="sk-abc123" curl https://x')).toBe(
          `KEY=${MASK} curl https://x`,
        );
      });

      it("masks a bare value", () => {
        expect(redactCommandSecrets("KEY=sk-abc123")).toBe(`KEY=${MASK}`);
      });

      it("masks a value under an export declaration", () => {
        expect(
          redactCommandSecrets('export OPENROUTER_KEY="sk-or-v1-xyz"'),
        ).toBe(`export OPENROUTER_KEY=${MASK}`);
      });

      it("masks a value containing spaces, which the parse keeps whole", () => {
        expect(redactCommandSecrets('TOKEN="a b c" deploy')).toBe(
          `TOKEN=${MASK} deploy`,
        );
      });

      it("leaves an assignment whose name binds no credential", () => {
        expect(redactCommandSecrets('OUT="/tmp/x" deploy')).toBe(
          'OUT="/tmp/x" deploy',
        );
      });

      it("leaves an assignment with no value at all", () => {
        expect(redactCommandSecrets("KEY=")).toBe("KEY=");
      });
    });

    describe("an assignment the grammar classifies as a plain word", () => {
      it("masks the value after an env prefix", () => {
        expect(redactCommandSecrets("env MY_KEY=abc deploy")).toBe(
          `env MY_KEY=${MASK} deploy`,
        );
      });

      it("leaves a long-option argument, which binds no name", () => {
        expect(redactCommandSecrets("deploy --my-key=abc")).toBe(
          "deploy --my-key=abc",
        );
      });
    });

    describe("an argument that names a sensitive header field", () => {
      it("masks a double-quoted header argument", () => {
        expect(
          redactCommandSecrets(
            'curl -sS -H "Authorization: Bearer sk-abc" https://x',
          ),
        ).toBe(`curl -sS -H "Authorization:${MASK}" https://x`);
      });

      it("masks a single-quoted header argument", () => {
        expect(
          redactCommandSecrets(
            "curl --header 'Authorization: Bearer sk-abc' https://x",
          ),
        ).toBe(`curl --header 'Authorization:${MASK}' https://x`);
      });

      it("masks a header argument concatenated onto its flag", () => {
        expect(
          redactCommandSecrets(
            'curl -H"Authorization: Bearer sk-abc" https://x',
          ),
        ).toBe(`curl -H"Authorization:${MASK}" https://x`);
      });

      it("masks a header whose value is an expansion, keeping the quoting balanced", () => {
        expect(
          redactCommandSecrets('curl -H "Authorization: "$TOKEN https://x'),
        ).toBe(`curl -H "Authorization:${MASK}" https://x`);
      });

      it("masks an unquoted header argument", () => {
        expect(redactCommandSecrets("curl -H X-Api-Key:sk-abc https://x")).toBe(
          `curl -H X-Api-Key:${MASK} https://x`,
        );
      });

      it("closes the quote the mask swallowed, not the one the argument opens with", () => {
        // The field name can straddle a quote boundary, so the argument's first
        // character is not always the quote that is open where the mask begins.
        expect(
          redactCommandSecrets('curl -H Auth"orization: "$TOKEN https://x'),
        ).toBe(`curl -H Auth"orization:${MASK}" https://x`);
      });

      it("leaves a header field that binds no credential", () => {
        expect(
          redactCommandSecrets(
            'curl -H "Content-Type: application/json" https://x',
          ),
        ).toBe('curl -H "Content-Type: application/json" https://x');
      });

      it("leaves a camel-cased name, which is no HTTP field name", () => {
        expect(
          redactCommandSecrets('grep -n "legalDirectionalKeys: readonly" x.ts'),
        ).toBe('grep -n "legalDirectionalKeys: readonly" x.ts');
      });
    });

    describe("values no name is bound to", () => {
      it("leaves a secret typed as a search pattern", () => {
        expect(redactCommandSecrets('grep -r "sk-ant-oat01-abc" .')).toBe(
          'grep -r "sk-ant-oat01-abc" .',
        );
      });

      it("leaves an assignment inside another language's source", () => {
        const command = 'python3 -c "print(sorted(d, key=lambda x: x[1]))"';

        expect(redactCommandSecrets(command)).toBe(command);
      });

      it("leaves a flag-separated value", () => {
        expect(redactCommandSecrets("sort --key 2 f.txt")).toBe(
          "sort --key 2 f.txt",
        );
      });
    });

    describe("several secrets in one command", () => {
      it("masks every one, left to right", () => {
        expect(
          redactCommandSecrets(
            'KEY=sk-one curl -H "Authorization: Bearer sk-two" && TOKEN=sk-three deploy',
          ),
        ).toBe(
          `KEY=${MASK} curl -H "Authorization:${MASK}" && TOKEN=${MASK} deploy`,
        );
      });

      it("masks an enclosing span once rather than nesting a second mask inside it", () => {
        expect(
          redactCommandSecrets('KEY="Authorization: Bearer x" deploy'),
        ).toBe(`KEY=${MASK} deploy`);
      });
    });

    describe("commands with nothing to mask", () => {
      it("returns an ordinary command unchanged", () => {
        expect(redactCommandSecrets("git status --short")).toBe(
          "git status --short",
        );
      });

      it("returns an empty command unchanged", () => {
        expect(redactCommandSecrets("")).toBe("");
      });

      it("masks what a recovering parse still resolved", () => {
        expect(redactCommandSecrets("KEY=sk-abc && echo )")).toBe(
          `KEY=${MASK} && echo )`,
        );
      });
    });
  });

  describe("before the parser is warm", () => {
    beforeEach(() => {
      resetWarmBashParser();
    });

    it("returns the command unchanged rather than raising", () => {
      expect(redactCommandSecrets('KEY="sk-abc123" curl https://x')).toBe(
        'KEY="sk-abc123" curl https://x',
      );
    });
  });
});

describe("maskCommandFields", () => {
  beforeEach(async () => {
    resetWarmBashParser();
    await warmBashParser();
  });
  afterEach(() => {
    resetWarmBashParser();
  });

  it("masks the command-bearing keys and leaves every other value alone", () => {
    expect(
      maskCommandFields({
        toolName: "bash",
        command: 'KEY="sk-abc" curl https://x',
        executedUnit: "TOKEN=sk-def deploy",
        matchedPattern: "curl *",
      }),
    ).toEqual({
      toolName: "bash",
      command: `KEY=${MASK} curl https://x`,
      executedUnit: `TOKEN=${MASK} deploy`,
      matchedPattern: "curl *",
    });
  });

  it("reaches a command nested inside another record", () => {
    expect(
      maskCommandFields({
        forwarding: { requests: [{ command: "KEY=sk-abc deploy" }] },
      }),
    ).toEqual({
      forwarding: { requests: [{ command: `KEY=${MASK} deploy` }] },
    });
  });

  it("leaves a non-string command value as it found it", () => {
    expect(maskCommandFields({ command: null })).toEqual({ command: null });
  });
});
