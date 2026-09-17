/**
 * authorizer-chain-audit.ts — Report a configured `authorizerChain` link this
 * node's registry could not resolve.
 *
 * Registrations are node-local (ADR 0012 decision 1), and a link produces a
 * *verdict* rather than a fact, so live authority stays converged at the
 * adjudicating node and a link is never inherited from an ancestor. A node that
 * adjudicates locally therefore runs whatever links loaded in it, and skips the
 * rest fail-safe (ADR 0007 §4 invariant 2) — the ask still reaches the
 * terminal. That resolution is deliberate; its silence was not. The operator
 * named a judge in config, did not get it, and the only trace was a line in a
 * JSONL file.
 *
 * The two halves of the alarm fire at different rates on purpose, for two
 * different readers. The review entry is the auditor's durable record and must
 * be complete, so it is written for every skipped ask. The visible warning is
 * for the operator about to answer the prompt the link should have answered, so
 * it is latched: one per configured name, whose count is bounded by
 * `authorizerChain.length`.
 *
 * A relaying node cannot reach this audit at all. `AuthorizerSelection` returns
 * from `linksFor` before resolving anything, recording
 * `authorizer_chain_delegated` instead — its ask is adjudicated one hop up
 * (ADR 0007 §7), where an absent link is the design rather than a
 * misconfiguration.
 */

/** The narrow log seam this audit needs (ISP): a durable record and a warning. */
export interface AuthorizerChainAuditLog {
  review(event: string, details?: Record<string, unknown>): void;
  warn(message: string): void;
}

/** A configured chain link this node's registry could not resolve. */
export interface UnregisteredLink {
  /** The operator-configured name, exactly as written in `authorizerChain`. */
  name: string;
  /** The ask whose chain resolution skipped it. */
  requestId: string;
}

/** The audit seam `AuthorizerSelection` drives when it skips a name (ISP). */
export interface UnregisteredLinkAuditor {
  auditUnregisteredLink(link: UnregisteredLink): void;
}

/**
 * The agent-facing text for a configured link that is not registered here.
 *
 * Three causes leave the identical absence — the provider was excluded from
 * this session's extensions, it failed to load, or it declined to register
 * because it has no configuration of its own (the shape
 * `@gotgenes/pi-permission-model-judge` uses to let an operator opt out
 * per project). The message names the likeliest and admits the others, rather
 * than accusing the operator of a contradiction it cannot prove.
 *
 * Every clause is a statement of what already happened. It deliberately does
 * not claim later asks will skip the link too: registration is honored any time
 * before an ask (ADR 0007 §4), so a link may yet arrive.
 */
export function unregisteredLinkMessage(name: string): string {
  return (
    `pi-permission-system: authorizerChain names "${name}", but no link with ` +
    "that name is registered in this session, so this ask is being decided " +
    "without it. Most often the extension providing the link is not loaded " +
    "here (a subagent child's excludedExtensionPackages does this); it may " +
    "also have failed to load, or declined to register because it has no " +
    "configuration of its own. Every skipped ask is recorded in the " +
    "permission review log as authorizer_chain_unregistered_link."
  );
}

/**
 * Records each skipped chain link, and warns the operator once per name.
 *
 * The latch is a plain field with no re-arm hook, because the extension factory
 * is re-invoked per session generation — a `/new`, `/resume`, `/fork`, or
 * `/import` switch builds a fresh audit. A `session_start` with
 * `reason: "reload"` reuses this instance and deliberately does not re-warn for
 * a name already reported; a name newly added to `authorizerChain` by that same
 * reload has no entry yet, so it warns on its first skip.
 */
export class AuthorizerChainAudit implements UnregisteredLinkAuditor {
  private readonly warned = new Set<string>();

  constructor(private readonly log: AuthorizerChainAuditLog) {}

  auditUnregisteredLink(link: UnregisteredLink): void {
    this.log.review("authorizer_chain_unregistered_link", {
      requestId: link.requestId,
      name: link.name,
    });
    if (this.warned.has(link.name)) {
      return;
    }
    this.warned.add(link.name);
    this.log.warn(unregisteredLinkMessage(link.name));
  }
}
