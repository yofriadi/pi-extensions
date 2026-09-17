import { describe, expect, it } from "vitest";
import {
  AuthorizerChainAudit,
  unregisteredLinkMessage,
} from "#src/authority/authorizer-chain-audit";
import { makeLogger } from "#test/helpers/session-fixtures";

function makeAudit(): {
  audit: AuthorizerChainAudit;
  logger: ReturnType<typeof makeLogger>;
} {
  const logger = makeLogger();
  return { audit: new AuthorizerChainAudit(logger), logger };
}

describe("AuthorizerChainAudit", () => {
  describe("the durable record", () => {
    it("records the skipped name against the ask that skipped it", () => {
      const { audit, logger } = makeAudit();

      audit.auditUnregisteredLink({ name: "model-judge", requestId: "req-1" });

      expect(logger.review).toHaveBeenCalledOnce();
      expect(logger.review).toHaveBeenCalledWith(
        "authorizer_chain_unregistered_link",
        { requestId: "req-1", name: "model-judge" },
      );
    });

    it("records every skip, including a repeat of the same name", () => {
      const { audit, logger } = makeAudit();

      audit.auditUnregisteredLink({ name: "model-judge", requestId: "req-1" });
      audit.auditUnregisteredLink({ name: "model-judge", requestId: "req-2" });
      audit.auditUnregisteredLink({ name: "model-judge", requestId: "req-3" });

      // The review stream is the auditor's record and must stay complete: the
      // latch below bounds the warning, never this.
      expect(logger.review).toHaveBeenCalledTimes(3);
      expect(logger.review).toHaveBeenLastCalledWith(
        "authorizer_chain_unregistered_link",
        { requestId: "req-3", name: "model-judge" },
      );
    });
  });

  describe("the visible warning", () => {
    it("warns with the message naming the skipped link", () => {
      const { audit, logger } = makeAudit();

      audit.auditUnregisteredLink({ name: "model-judge", requestId: "req-1" });

      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        unregisteredLinkMessage("model-judge"),
      );
    });

    it("warns once per name, however many asks skip it", () => {
      const { audit, logger } = makeAudit();

      audit.auditUnregisteredLink({ name: "model-judge", requestId: "req-1" });
      audit.auditUnregisteredLink({ name: "model-judge", requestId: "req-2" });
      audit.auditUnregisteredLink({ name: "model-judge", requestId: "req-3" });

      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it("warns again for a different name", () => {
      const { audit, logger } = makeAudit();

      audit.auditUnregisteredLink({ name: "model-judge", requestId: "req-1" });
      audit.auditUnregisteredLink({ name: "typo-judge", requestId: "req-2" });

      // Each configured name is its own misconfiguration, and the count is
      // bounded by `authorizerChain.length`.
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenLastCalledWith(
        unregisteredLinkMessage("typo-judge"),
      );
    });
  });
});

describe("unregisteredLinkMessage", () => {
  it("names the link, the config field, and the review event", () => {
    const message = unregisteredLinkMessage("model-judge");

    expect(message).toContain('"model-judge"');
    expect(message).toContain("authorizerChain");
    expect(message).toContain("authorizer_chain_unregistered_link");
  });

  it("admits all three causes rather than asserting one", () => {
    const message = unregisteredLinkMessage("model-judge");

    // The operator cannot tell an exclusion from a load failure from a
    // provider that declined, so the message names the likeliest and admits
    // the others instead of accusing.
    expect(message).toContain("excludedExtensionPackages");
    expect(message).toContain("failed to load");
    expect(message).toContain("no configuration of its own");
  });

  it("claims only that this ask was decided without the link", () => {
    const message = unregisteredLinkMessage("model-judge");

    // A link may still register before a later ask (ADR 0007 §4), so the
    // message must not predict that the ones after it are affected too.
    expect(message).toContain("this ask is being decided without it");
  });
});
