import { describe, expect, test } from "vitest";
import { NO_REMEDY_PLAN_HINT } from "./no-remedy-plan-hint";
import {
  type RefusalAction,
  type RefusalOutcome,
  receiptRefusalAction,
  refusalAction,
  refusalGuidance,
  statedRefusalOutcome,
  withheldOutputGuidance,
} from "./refusal-outcome";

describe("statedRefusalOutcome", () => {
  test.each<{
    name: string;
    fields: Parameters<typeof statedRefusalOutcome>[0];
    remedies: boolean;
    outcome: RefusalOutcome | undefined;
  }>([
    { name: "nothing stated", fields: {}, remedies: true, outcome: undefined },
    {
      name: "an integrity fault",
      fields: { outcomes: ["integrity"], deciding: "integrity" },
      remedies: false,
      outcome: { kind: "integrity" },
    },
    {
      name: "a hard block",
      fields: { outcomes: ["hard_block"], deciding: "hard_block" },
      remedies: false,
      outcome: { kind: "hard_block" },
    },
    {
      name: "a missing fact",
      fields: {
        outcomes: ["missing_fact"],
        deciding: "missing_fact",
        retry: "after_repair",
      },
      remedies: false,
      outcome: { kind: "missing_fact", retry: "after_repair" },
    },
    {
      name: "remedies",
      fields: {
        outcomes: ["waivable_gap", "consent", "waivable_gap"],
        deciding: "consent",
      },
      remedies: true,
      outcome: {
        kind: "remediable",
        deciding: "consent",
        held: ["waivable_gap", "consent"],
      },
    },
    {
      name: "the agent's choice",
      fields: { outcomes: ["agent_choice"], deciding: "agent_choice" },
      remedies: true,
      outcome: {
        kind: "remediable",
        deciding: "agent_choice",
        held: ["agent_choice"],
      },
    },
  ])("reads $name", ({ fields, remedies, outcome }) => {
    expect(statedRefusalOutcome(fields, remedies)).toEqual({ outcome });
  });

  test.each<{
    name: string;
    fields: Parameters<typeof statedRefusalOutcome>[0];
    remedies: boolean;
  }>([
    {
      name: "outcomes without the deciding one",
      fields: { outcomes: ["hard_block"] },
      remedies: false,
    },
    {
      name: "a retry hint alone",
      fields: { retry: "later" },
      remedies: false,
    },
    {
      name: "a missing fact without its retry hint",
      fields: { outcomes: ["missing_fact"], deciding: "missing_fact" },
      remedies: false,
    },
    {
      name: "a missing fact beside offers",
      fields: {
        outcomes: ["missing_fact"],
        deciding: "missing_fact",
        retry: "later",
      },
      remedies: true,
    },
    {
      name: "a retry hint on a hard block",
      fields: {
        outcomes: ["hard_block"],
        deciding: "hard_block",
        retry: "later",
      },
      remedies: false,
    },
    {
      name: "a retry hint on remedies",
      fields: { outcomes: ["consent"], deciding: "consent", retry: "later" },
      remedies: true,
    },
    {
      name: "a hard block beside offers",
      fields: { outcomes: ["hard_block"], deciding: "hard_block" },
      remedies: true,
    },
    {
      name: "an integrity fault beside offers",
      fields: { outcomes: ["integrity"], deciding: "integrity" },
      remedies: true,
    },
    {
      name: "a hard block beside a remedy",
      fields: { outcomes: ["hard_block", "consent"], deciding: "hard_block" },
      remedies: true,
    },
    {
      name: "a missing fact beside a remedy",
      fields: {
        outcomes: ["missing_fact", "waivable_gap"],
        deciding: "waivable_gap",
      },
      remedies: true,
    },
    {
      name: "a deciding remedy that is not held",
      fields: { outcomes: ["waivable_gap"], deciding: "consent" },
      remedies: true,
    },
  ])("refuses $name", ({ fields, remedies }) => {
    expect(statedRefusalOutcome(fields, remedies)).toHaveProperty("problem");
  });
});

describe("refusalAction", () => {
  const listed = { offers: ["offer-1"], review: undefined };
  const none = { offers: [], review: undefined };
  const unknown = { offers: undefined, review: undefined };
  test.each<{
    name: string;
    outcome: RefusalOutcome | undefined;
    lists: { offers: string[] | undefined; review: unknown[] | undefined };
    action: RefusalAction;
  }>([
    {
      name: "an integrity fault",
      outcome: { kind: "integrity" },
      lists: none,
      action: { kind: "refuse", why: "integrity" },
    },
    {
      name: "a hard block",
      outcome: { kind: "hard_block" },
      lists: none,
      action: { kind: "refuse", why: "hard_block" },
    },
    {
      name: "a missing fact to retry later",
      outcome: { kind: "missing_fact", retry: "later" },
      lists: none,
      action: { kind: "refuse_unjudged", retry: "later" },
    },
    {
      name: "a missing fact to retry after repair",
      outcome: { kind: "missing_fact", retry: "after_repair" },
      lists: unknown,
      action: { kind: "refuse_unjudged", retry: "after_repair" },
    },
    {
      name: "remedies",
      outcome: {
        kind: "remediable",
        deciding: "waivable_gap",
        held: ["waivable_gap"],
      },
      lists: listed,
      action: { kind: "offer_remedies" },
    },
    // A receipt written before outcomes were stated is read by what it lists.
    {
      name: "an unstated ruling with an offer",
      outcome: undefined,
      lists: listed,
      action: { kind: "offer_remedies" },
    },
    {
      name: "an unstated ruling with a review",
      outcome: undefined,
      lists: { offers: [], review: [{ offer_id: "review-1" }] },
      action: { kind: "offer_remedies" },
    },
    {
      name: "an unstated ruling with no offers",
      outcome: undefined,
      lists: none,
      action: { kind: "refuse", why: "hard_block" },
    },
    {
      name: "an unstated ruling that lists nothing",
      outcome: undefined,
      lists: unknown,
      action: { kind: "refuse", why: "unstated" },
    },
  ])("maps $name", ({ outcome, lists, action }) => {
    expect(refusalAction({ outcome, ...lists })).toEqual(action);
  });
});

describe("receiptRefusalAction", () => {
  test.each<{
    name: string;
    receipt: unknown;
    action: RefusalAction | undefined;
  }>([
    {
      name: "an offered ruling",
      receipt: { decision: "deny_call", offers: [{ offer_id: "offer-1" }] },
      action: { kind: "offer_remedies" },
    },
    {
      name: "a stated remedy",
      receipt: {
        decision: "deny_call",
        outcomes: ["consent"],
        deciding: "consent",
        offers: [{ offer_id: "offer-1" }],
      },
      action: { kind: "offer_remedies" },
    },
    {
      name: "a hard block that also lists an offer",
      receipt: {
        decision: "deny_call",
        outcomes: ["hard_block"],
        deciding: "hard_block",
        offers: [{ offer_id: "offer-1" }],
      },
      action: undefined,
    },
    {
      name: "a cancelled call's receipt",
      receipt: { decision: "deny_call" },
      action: { kind: "refuse", why: "unstated" },
    },
    {
      name: "an admission",
      receipt: { decision: "allow_call" },
      action: undefined,
    },
  ])("reads $name", ({ receipt, action }) => {
    expect(receiptRefusalAction(receipt)).toEqual(action);
  });
});

describe("refusalGuidance", () => {
  test("adds nothing while remedies stand or a ruling states nothing, and the no-plan hint for a refusal nothing lifts", () => {
    expect(refusalGuidance({ kind: "offer_remedies" })).toBe("");
    expect(refusalGuidance({ kind: "refuse", why: "unstated" })).toBe("");
    expect(refusalGuidance({ kind: "refuse", why: "integrity" })).toBe(
      NO_REMEDY_PLAN_HINT,
    );
    expect(refusalGuidance({ kind: "refuse", why: "hard_block" })).toBe(
      NO_REMEDY_PLAN_HINT,
    );
  });

  test("gives an unjudged call guidance that differs by its retry hint", () => {
    const later = refusalGuidance({ kind: "refuse_unjudged", retry: "later" });
    const afterRepair = refusalGuidance({
      kind: "refuse_unjudged",
      retry: "after_repair",
    });
    expect(later).not.toBe("");
    expect(afterRepair).not.toBe("");
    expect(later).not.toBe(afterRepair);
    expect(later).not.toBe(NO_REMEDY_PLAN_HINT);
  });
});

describe("withheldOutputGuidance", () => {
  test("speaks only for output the runtime could not judge, in words of its own", () => {
    for (const action of [
      { kind: "offer_remedies" },
      { kind: "refuse", why: "hard_block" },
      { kind: "refuse", why: "integrity" },
      { kind: "refuse", why: "unstated" },
    ] as const)
      expect(withheldOutputGuidance(action)).toBe("");
    for (const retry of ["later", "after_repair"] as const) {
      const action = { kind: "refuse_unjudged", retry } as const;
      expect(withheldOutputGuidance(action)).not.toBe("");
      // A call that already ran is never told to make the call again.
      expect(withheldOutputGuidance(action)).not.toBe(refusalGuidance(action));
    }
    expect(
      withheldOutputGuidance({ kind: "refuse_unjudged", retry: "later" }),
    ).not.toBe(
      withheldOutputGuidance({
        kind: "refuse_unjudged",
        retry: "after_repair",
      }),
    );
  });
});
