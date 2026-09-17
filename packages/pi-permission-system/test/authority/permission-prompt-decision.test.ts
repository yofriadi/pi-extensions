import { describe, expect, it } from "vitest";
import {
  initialPromptState,
  type PromptModelConfig,
  type PromptOutcome,
  reducePrompt,
  visibleActions,
} from "#src/authority/permission-prompt-decision";
import { DEFAULT_DIALOG_KEYS } from "#src/config/dialog-keys";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Narrow a reducer outcome to its render arm, failing the test if it decided.
 *
 * An assertion signature rather than a bare `throw`: reading `.state` off the
 * union needs narrowing, but a `throw` reports outside the assertion library,
 * so a wrong arm arrives as a stack trace naming neither what was expected nor
 * what came back. `expect.unreachable` returns `never`, so it narrows and
 * reports.
 */
function assertRender(
  outcome: PromptOutcome,
): asserts outcome is Extract<PromptOutcome, { kind: "render" }> {
  if (outcome.kind !== "render") {
    expect.unreachable(`expected a render, got ${JSON.stringify(outcome)}`);
  }
}

function makeConfig(
  overrides: Partial<PromptModelConfig> = {},
): PromptModelConfig {
  return {
    doublePressToConfirm: true,
    sessionLabel: "Yes, for this session",
    keys: DEFAULT_DIALOG_KEYS,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("reducePrompt", () => {
  describe("initial state", () => {
    it("starts on the decision step highlighting approve with nothing armed", () => {
      const state = initialPromptState(makeConfig());
      expect(state).toEqual({
        step: "decision",
        highlightedAction: "approve",
        armedAction: undefined,
        hint: "",
        reasonError: undefined,
        scopeServing: false,
        grantWidth: "proven",
      });
    });
  });

  describe("double-press to confirm (enabled)", () => {
    it("arms the option on the first hotkey press without deciding", () => {
      const config = makeConfig();
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approve",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "decision",
          highlightedAction: "approve",
          armedAction: "approve",
          hint: "Press y again to approve.",
          reasonError: undefined,
          scopeServing: false,
          grantWidth: "proven",
        },
      });
    });

    it("commits the decision on the confirming second press of the same key", () => {
      const config = makeConfig();
      const armed = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approve",
      });
      assertRender(armed);
      const outcome = reducePrompt(config, armed.state, {
        type: "hotkey",
        action: "approve",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved" },
      });
    });

    it("re-arms when a different hotkey is pressed", () => {
      const config = makeConfig();
      const armedY = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approve",
      });
      assertRender(armedY);
      const armedN = reducePrompt(config, armedY.state, {
        type: "hotkey",
        action: "deny",
      });
      expect(armedN).toEqual({
        kind: "render",
        state: {
          step: "decision",
          highlightedAction: "deny",
          armedAction: "deny",
          hint: "Press n again to deny.",
          reasonError: undefined,
          scopeServing: false,
          grantWidth: "proven",
        },
      });
    });

    it("commits deny on the second press of n", () => {
      const config = makeConfig();
      const armed = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "deny",
      });
      assertRender(armed);
      const outcome = reducePrompt(config, armed.state, {
        type: "hotkey",
        action: "deny",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: false, state: "denied" },
      });
    });
  });

  describe("double-press to confirm (disabled)", () => {
    it("commits immediately on the first hotkey press", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approve",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved" },
      });
    });
  });

  describe("navigation and enter", () => {
    it("moves the highlight and clears any armed key without deciding", () => {
      const config = makeConfig();
      const armed = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approve",
      });
      assertRender(armed);
      const outcome = reducePrompt(config, armed.state, {
        type: "nav",
        direction: "down",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "decision",
          highlightedAction: "approveSession",
          armedAction: undefined,
          hint: "",
          reasonError: undefined,
          scopeServing: false,
          grantWidth: "proven",
        },
      });
    });

    it("wraps the highlight from the last option back to the first", () => {
      const config = makeConfig();
      let state = initialPromptState(config);
      for (const _ of [0, 1, 2, 3]) {
        const outcome = reducePrompt(config, state, {
          type: "nav",
          direction: "up",
        });
        assertRender(outcome);
        state = outcome.state;
      }
      // up from y wraps to r, then walks r→n→s→y over four presses
      expect(state.highlightedAction).toBe("approve");
    });

    it("confirms the highlighted option in a single enter press even when double-press is enabled", () => {
      const config = makeConfig();
      const down = reducePrompt(config, initialPromptState(config), {
        type: "nav",
        direction: "down",
      });
      assertRender(down);
      // highlight is now s; move once more to n
      const down2 = reducePrompt(config, down.state, {
        type: "nav",
        direction: "down",
      });
      assertRender(down2);
      const outcome = reducePrompt(config, down2.state, { type: "confirm" });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: false, state: "denied" },
      });
    });
  });

  describe("escape", () => {
    it("denies from the decision step", () => {
      const config = makeConfig();
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "cancel",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: false, state: "denied" },
      });
    });
  });

  describe("deny with reason", () => {
    it("opens the reason step on confirming r (double-press enabled)", () => {
      const config = makeConfig();
      const armed = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "denyWithReason",
      });
      assertRender(armed);
      const outcome = reducePrompt(config, armed.state, {
        type: "hotkey",
        action: "denyWithReason",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "reason",
          highlightedAction: "denyWithReason",
          armedAction: undefined,
          hint: "",
          reasonError: undefined,
          scopeServing: false,
          grantWidth: "proven",
        },
      });
    });

    it("opens the reason step immediately when double-press is disabled", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "denyWithReason",
      });
      expect(outcome.kind).toBe("render");
      assertRender(outcome);
      expect(outcome.state.step).toBe("reason");
    });

    it("rejects an empty reason and keeps the reason step open", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "denyWithReason",
      });
      assertRender(opened);
      const outcome = reducePrompt(config, opened.state, {
        type: "submitReason",
        draft: "   ",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "reason",
          highlightedAction: "denyWithReason",
          armedAction: undefined,
          hint: "",
          reasonError: "A reason is required.",
          scopeServing: false,
          grantWidth: "proven",
        },
      });
    });

    it("commits a denied_with_reason decision for a non-empty reason", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "denyWithReason",
      });
      assertRender(opened);
      const outcome = reducePrompt(config, opened.state, {
        type: "submitReason",
        draft: "  not now  ",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: {
          approved: false,
          state: "denied_with_reason",
          denialReason: "not now",
        },
      });
    });

    it("navigates back to the decision step on escape from the reason step", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "denyWithReason",
      });
      assertRender(opened);
      const outcome = reducePrompt(config, opened.state, { type: "cancel" });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "decision",
          highlightedAction: "denyWithReason",
          armedAction: undefined,
          hint: "",
          reasonError: undefined,
          scopeServing: false,
          grantWidth: "proven",
        },
      });
    });
  });

  describe("approve-for-session scope (forwarded asks)", () => {
    const sessionScope = {
      subagentLabel: "This subagent only",
      servingSessionLabel: "The whole session",
    };

    it("opens the scope step when s is confirmed and a sessionScope is offered", () => {
      const config = makeConfig({ doublePressToConfirm: false, sessionScope });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approveSession",
      });
      expect(outcome.kind).toBe("render");
      assertRender(outcome);
      expect(outcome.state.step).toBe("scope");
      expect(outcome.state.scopeServing).toBe(false);
    });

    it("commits the least-privilege subagent scope by default", () => {
      const config = makeConfig({ doublePressToConfirm: false, sessionScope });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approveSession",
      });
      assertRender(opened);
      const outcome = reducePrompt(config, opened.state, { type: "confirm" });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved_for_session" },
      });
    });

    it("commits the serving-session scope when the second option is chosen", () => {
      const config = makeConfig({ doublePressToConfirm: false, sessionScope });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approveSession",
      });
      assertRender(opened);
      const moved = reducePrompt(config, opened.state, {
        type: "nav",
        direction: "down",
      });
      assertRender(moved);
      expect(moved.state.scopeServing).toBe(true);
      const outcome = reducePrompt(config, moved.state, { type: "confirm" });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved_for_serving_session" },
      });
    });

    it("navigates back to the decision step on escape from the scope step", () => {
      const config = makeConfig({ doublePressToConfirm: false, sessionScope });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approveSession",
      });
      assertRender(opened);
      const outcome = reducePrompt(config, opened.state, { type: "cancel" });
      expect(outcome.kind).toBe("render");
      assertRender(outcome);
      expect(outcome.state.step).toBe("decision");
    });

    it("commits approved_for_session directly when no sessionScope is offered", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approveSession",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved_for_session" },
      });
    });
  });

  describe("both-directions session grant (#813)", () => {
    const widthLabel =
      'Yes, allow reads and writes to "/tmp/*" for this session';

    it("offers the width option only when the ask is widenable", () => {
      expect(visibleActions(makeConfig({ widthLabel }))).toEqual([
        "approve",
        "approveSession",
        "approveSessionBoth",
        "deny",
        "denyWithReason",
      ]);
      expect(visibleActions(makeConfig())).toEqual([
        "approve",
        "approveSession",
        "deny",
        "denyWithReason",
      ]);
    });

    it("commits the family width on b", () => {
      const config = makeConfig({ doublePressToConfirm: false, widthLabel });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approveSessionBoth",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: {
          approved: true,
          state: "approved_for_session",
          sessionGrantWidth: "family",
        },
      });
    });

    it("leaves s at the proven width, naming no width at all", () => {
      const config = makeConfig({ doublePressToConfirm: false, widthLabel });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approveSession",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved_for_session" },
      });
    });

    it("arms b like any other hotkey under double-press", () => {
      const config = makeConfig({ widthLabel });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approveSessionBoth",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "decision",
          highlightedAction: "approveSessionBoth",
          armedAction: "approveSessionBoth",
          hint: "Press b again to approve both directions for this session.",
          reasonError: undefined,
          scopeServing: false,
          grantWidth: "proven",
        },
      });
    });

    it("ignores b when the ask is not widenable", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approveSessionBoth",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: initialPromptState(config),
      });
    });

    it("walks five options when the width option is offered", () => {
      const config = makeConfig({ widthLabel });
      let state = initialPromptState(config);
      const seen: string[] = [];
      for (const _ of [0, 1, 2, 3, 4]) {
        const outcome = reducePrompt(config, state, {
          type: "nav",
          direction: "down",
        });
        assertRender(outcome);
        state = outcome.state;
        seen.push(state.highlightedAction);
      }
      expect(seen).toEqual([
        "approveSession",
        "approveSessionBoth",
        "deny",
        "denyWithReason",
        "approve",
      ]);
    });

    it("skips b when navigating an ask that is not widenable", () => {
      const config = makeConfig();
      let state = initialPromptState(config);
      const seen: string[] = [];
      for (const _ of [0, 1, 2, 3]) {
        const outcome = reducePrompt(config, state, {
          type: "nav",
          direction: "down",
        });
        assertRender(outcome);
        state = outcome.state;
        seen.push(state.highlightedAction);
      }
      expect(seen).toEqual([
        "approveSession",
        "deny",
        "denyWithReason",
        "approve",
      ]);
    });

    describe("with a forwarded ask's scope step", () => {
      const sessionScope = {
        subagentLabel: "This subagent only",
        servingSessionLabel: "The whole session",
      };

      it("carries the width chosen on b through the scope step", () => {
        const config = makeConfig({
          doublePressToConfirm: false,
          widthLabel,
          sessionScope,
        });
        const opened = reducePrompt(config, initialPromptState(config), {
          type: "hotkey",
          action: "approveSessionBoth",
        });
        assertRender(opened);
        expect(opened.state.step).toBe("scope");
        expect(reducePrompt(config, opened.state, { type: "confirm" })).toEqual(
          {
            kind: "decision",
            decision: {
              approved: true,
              state: "approved_for_session",
              sessionGrantWidth: "family",
            },
          },
        );
      });

      it("carries the width onto a whole-serving-session grant too", () => {
        const config = makeConfig({
          doublePressToConfirm: false,
          widthLabel,
          sessionScope,
        });
        const opened = reducePrompt(config, initialPromptState(config), {
          type: "hotkey",
          action: "approveSessionBoth",
        });
        assertRender(opened);
        const moved = reducePrompt(config, opened.state, {
          type: "nav",
          direction: "down",
        });
        assertRender(moved);
        expect(reducePrompt(config, moved.state, { type: "confirm" })).toEqual({
          kind: "decision",
          decision: {
            approved: true,
            state: "approved_for_serving_session",
            sessionGrantWidth: "family",
          },
        });
      });

      it("forgets a backed-out width when the scope step cancels", () => {
        const config = makeConfig({
          doublePressToConfirm: false,
          widthLabel,
          sessionScope,
        });
        const opened = reducePrompt(config, initialPromptState(config), {
          type: "hotkey",
          action: "approveSessionBoth",
        });
        assertRender(opened);
        const cancelled = reducePrompt(config, opened.state, {
          type: "cancel",
        });
        assertRender(cancelled);
        expect(cancelled.state.grantWidth).toBe("proven");

        // The narrow option must not inherit the width the user backed out of.
        const reopened = reducePrompt(config, cancelled.state, {
          type: "hotkey",
          action: "approveSession",
        });
        assertRender(reopened);
        expect(
          reducePrompt(config, reopened.state, { type: "confirm" }),
        ).toEqual({
          kind: "decision",
          decision: { approved: true, state: "approved_for_session" },
        });
      });
    });
  });

  describe("bound characters", () => {
    const REMAPPED = {
      approve: "1",
      approveSession: "2",
      approveSessionBoth: "3",
      deny: "4",
      denyWithReason: "5",
    } as const;

    it("names the bound character in the arming hint", () => {
      const config = makeConfig({ keys: REMAPPED });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "approve",
      });
      assertRender(outcome);
      expect(outcome.state.hint).toBe("Press 1 again to approve.");
    });

    it("names the default letter when no binding was configured", () => {
      const config = makeConfig();
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        action: "deny",
      });
      assertRender(outcome);
      expect(outcome.state.hint).toBe("Press n again to deny.");
    });
  });
});
