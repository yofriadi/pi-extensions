import { describe, expect, it } from "vitest";
import {
  type BashReparser,
  getParser,
  type TSNode,
} from "#src/access-intent/bash/parser";
import { withSalvagedRoots } from "#src/access-intent/bash/unresolved-salvage";

/** The reported command: a heredoc redirect, `2>&1`, and a pipe together. */
const REPORTED =
  "git add -A . && git commit -F - <<'MSG' 2>&1 | rm -rf /tmp/x\nmsg\nMSG";

/**
 * Run `withSalvagedRoots` over a real parse of `command`, returning the source
 * text of each salvaged root.
 *
 * Each root is its own re-parsed `program`, so the text is what identifies the
 * region that was salvaged. Reading it inside the callback is the point: the
 * trees the roots belong to are deleted as it returns, so anything a caller
 * keeps must be copied out.
 */
async function salvagedTextOf(command: string): Promise<string[]> {
  const parser = await getParser();
  const tree = parser.parse(command);
  if (!tree) throw new Error("parse returned null");
  try {
    return withSalvagedRoots(tree.rootNode, parser, (roots) =>
      roots.map((root) => root.text),
    );
  } finally {
    tree.delete();
  }
}

describe("withSalvagedRoots", () => {
  describe("a region the primary parse could not resolve", () => {
    it("salvages the redirect holding the command tree-sitter dropped", async () => {
      expect(await salvagedTextOf(REPORTED)).toEqual(["2>&1 | rm -rf /tmp/x"]);
    });

    it("salvages a region whose dropped command reads a path", async () => {
      expect(
        await salvagedTextOf("cat <<'MSG' 2>&1 | cat /etc/shadow\nmsg\nMSG"),
      ).toEqual(["2>&1 | cat /etc/shadow"]);
    });

    it("salvages the innermost unresolved node, not an enclosing one", async () => {
      // `redirected_statement` and `heredoc_redirect` both report the error
      // too, and each carries the whole command line; re-parsing either fails
      // again for the same reason and salvages nothing.
      const salvaged = await salvagedTextOf(REPORTED);
      expect(salvaged).not.toContain(REPORTED);
      expect(salvaged).toEqual(["2>&1 | rm -rf /tmp/x"]);
    });
  });

  describe("a region whose own re-parse fails", () => {
    it.each([
      ["a read-write open inside the redirect", "cat <> rw.txt"],
      [
        "a read-write open beside a resolved redirect",
        "echo hi > out.txt <> rw.txt; rm -rf /tmp/y",
      ],
      ["a stranded arithmetic opener", "cat $(( > out.txt"],
    ])("salvages nothing from %s", async (_label, command) => {
      // Without the clean-re-parse guard these emit `">"` and `"$(("` as
      // command units — invented text matched against the bash rules (#814).
      expect(await salvagedTextOf(command)).toEqual([]);
    });
  });

  describe("a failure the whole program carries", () => {
    it.each([
      [
        "an unterminated heredoc whose body re-parses as garbage",
        "cat <<'EOF'\nsee `rm -rf x` here",
      ],
      ["an unbalanced quote", 'echo "$(rm x)'],
      ["an unterminated control-flow statement", "for f in a; do rm $f"],
      ["an unterminated brace group", "{ echo hi"],
    ])("salvages nothing from %s", async (_label, command) => {
      // The root is the only unresolved node, and re-parsing it reproduces the
      // same failure — so tree-sitter's invented structure (#742) is never
      // re-read as commands.
      expect(await salvagedTextOf(command)).toEqual([]);
    });
  });

  describe("a program that parsed cleanly", () => {
    it.each([
      ["a lone command", "echo hi"],
      ["a chain", "cd /repo && git push"],
      ["a heredoc without the failing combination", "cat <<'M'\nbody\nM"],
    ])("salvages nothing from %s", async (_label, command) => {
      expect(await salvagedTextOf(command)).toEqual([]);
    });
  });

  describe("which node type holds the region", () => {
    /**
     * A stub node tree, so the rule can be exercised on a shape
     * `tree-sitter-bash` 0.25.1 does not currently produce.
     *
     * Every salvageable region of the one grammar gap this package has met is
     * a `file_redirect` — probed across 25 spellings of it, including the gap
     * nested in a control-flow body, a subshell, and a substitution. So no
     * real command distinguishes "the innermost unresolved node" from "the
     * innermost unresolved `file_redirect`", and a stub is the only way to
     * pin which rule is implemented. The distinction is the whole point: ADR
     * 0013's fail-closed clause is triggered by the parse's health rather
     * than by a node type, and a type-keyed salvage would silently drop the
     * next grammar gap that lands somewhere else.
     */
    function stubNode(
      type: string,
      text: string,
      children: TSNode[] = [],
    ): TSNode {
      return {
        type,
        text,
        startIndex: 0,
        endIndex: text.length,
        childCount: children.length,
        isNamed: true,
        hasError: type === "ERROR" || children.some((c) => c.hasError),
        previousSibling: null,
        child: (index) => children[index] ?? null,
      };
    }

    it("salvages a region no redirect holds", async () => {
      const parser = await getParser();
      const region = stubNode("some_future_node", "rm -rf /tmp/x", [
        stubNode("ERROR", "|"),
      ]);
      const root = stubNode("program", "rm -rf /tmp/x", [region]);

      expect(
        withSalvagedRoots(root, parser, (roots) =>
          roots.map((salvaged) => salvaged.text),
        ),
      ).toEqual(["rm -rf /tmp/x"]);
    });
  });

  describe("the trees it creates", () => {
    it("deletes every salvage tree before returning", async () => {
      const parser = await getParser();
      const created: { deleted: boolean }[] = [];
      const counting: BashReparser = {
        parse: (input) => {
          const tree = parser.parse(input);
          if (!tree) return null;
          const record = { deleted: false };
          created.push(record);
          return {
            rootNode: tree.rootNode,
            delete: () => {
              record.deleted = true;
              tree.delete();
            },
          };
        },
      };
      const tree = parser.parse(REPORTED);
      if (!tree) throw new Error("parse returned null");
      try {
        withSalvagedRoots(tree.rootNode, counting, (roots) => roots.length);
      } finally {
        tree.delete();
      }
      expect(created.length).toBeGreaterThan(0);
      expect(created.every(({ deleted }) => deleted)).toBe(true);
    });

    it("deletes them even when the caller throws", async () => {
      const parser = await getParser();
      let deleted = 0;
      const counting: BashReparser = {
        parse: (input) => {
          const tree = parser.parse(input);
          if (!tree) return null;
          return {
            rootNode: tree.rootNode,
            delete: () => {
              deleted += 1;
              tree.delete();
            },
          };
        },
      };
      const tree = parser.parse(REPORTED);
      if (!tree) throw new Error("parse returned null");
      try {
        expect(() =>
          withSalvagedRoots(tree.rootNode, counting, (): TSNode[] => {
            throw new Error("boom");
          }),
        ).toThrow("boom");
      } finally {
        tree.delete();
      }
      expect(deleted).toBe(1);
    });
  });
});
