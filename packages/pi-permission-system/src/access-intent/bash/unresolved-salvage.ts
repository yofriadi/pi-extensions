import {
  type BashReparser,
  parseUnresolvedWithin,
  type TSNode,
} from "./parser";

/**
 * Run `use` over the roots of every region the primary parse could not resolve
 * but which re-parses cleanly on its own, then delete the trees it created.
 *
 * `tree-sitter-bash` 0.25.1 cannot parse a heredoc redirect combined with
 * `2>&1` **and** a pipe, though each pairing alone is fine. Its recovery hangs
 * an `ERROR` node holding only the `|` under `heredoc_redirect → file_redirect`
 * and leaves the piped command's words as plain siblings of it — and
 * `heredoc_redirect` is an execution host, descended for the substitutions it
 * may carry and never read for text. So `git commit -F - <<'MSG' 2>&1 | rm -rf
 * /tmp/x` enumerates `git commit -F` and nothing else, and a configured
 * `bash: {"rm -rf *": "deny"}` is never evaluated against a command that
 * really runs (#875).
 *
 * Re-parsing the dropped region's own source text recovers it, because the
 * grammar gap is in the *combination* — `2>&1 | rm -rf /tmp/x` parses
 * perfectly on its own.
 *
 * The roots are handed to a callback rather than returned because each belongs
 * to a tree that must outlive its use and be released afterwards, exactly as
 * the primary parse's caller already does for its own tree.
 *
 * Salvaging is purely additive: a caller enumerates these roots *in addition
 * to* the primary one, so the result can only ever be more restrictive.
 */
export function withSalvagedRoots<T>(
  primary: TSNode,
  reparser: BashReparser,
  use: (salvaged: readonly TSNode[]) => T,
): T {
  const trees: { rootNode: TSNode; delete(): void }[] = [];
  try {
    for (const candidate of unresolvedRegionsWithin(primary)) {
      const tree = reparser.parse(candidate.text);
      if (!tree) continue;
      // The whole safety argument: tree-sitter's error recovery *invents* the
      // structure inside an unresolved region (#742), and invented structure
      // does not re-parse. Without this check `cat <> rw.txt` salvages a
      // command unit whose text is `">"`, matched against the bash rules like
      // any real command.
      if (parseUnresolvedWithin(tree.rootNode)) {
        tree.delete();
        continue;
      }
      trees.push(tree);
    }
    return use(trees.map(({ rootNode }) => rootNode));
  } finally {
    for (const tree of trees) tree.delete();
  }
}

/**
 * The innermost nodes beneath `root` whose subtree the parser could not
 * resolve, in source order.
 *
 * Three exclusions shape the answer.
 *
 * An `ERROR` node is never a candidate and is never descended in search of
 * one: its interior is recovery's invention rather than anything observed
 * (#742), so the region worth re-parsing is the node that *holds* it.
 *
 * Only the innermost such node is offered. An enclosing statement reports the
 * error too, and its text re-parses to the same failure, so offering it
 * salvages nothing while burying the fragment that would have worked.
 *
 * `root` itself is never a candidate, for the same reason taken to its limit:
 * re-parsing the whole source reproduces the whole failure by construction.
 */
function unresolvedRegionsWithin(root: TSNode): TSNode[] {
  const found: TSNode[] = [];
  collectInnermostUnresolved(root, root, found);
  return found;
}

function collectInnermostUnresolved(
  node: TSNode,
  root: TSNode,
  found: TSNode[],
): void {
  if (!parseUnresolvedWithin(node)) return;
  const before = found.length;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type !== "ERROR") {
      collectInnermostUnresolved(child, root, found);
    }
  }
  const foundDeeper = found.length > before;
  if (!foundDeeper && node !== root && node.type !== "ERROR") found.push(node);
}
