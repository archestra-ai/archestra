import { describe, expect, test } from "vitest";
import { NO_REMEDY_PLAN_HINT } from "./no-remedy-plan-hint";
import {
  type RefusalAction,
  type RefusalOutcome,
  refusalAction,
  refusalGuidance,
  statedRefusalOutcome,
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
  test.each<{
    outcome: RefusalOutcome | undefined;
    remedies: boolean;
    action: RefusalAction;
  }>([
    {
      outcome: { kind: "integrity" },
      remedies: false,
      action: { kind: "refuse", why: "integrity" },
    },
    {
      outcome: { kind: "hard_block" },
      remedies: false,
      action: { kind: "refuse", why: "hard_block" },
    },
    {
      outcome: { kind: "missing_fact", retry: "later" },
      remedies: false,
      action: { kind: "refuse_unjudged", retry: "later" },
    },
    {
      outcome: { kind: "missing_fact", retry: "after_repair" },
      remedies: false,
      action: { kind: "refuse_unjudged", retry: "after_repair" },
    },
    {
      outcome: {
        kind: "remediable",
        deciding: "waivable_gap",
        held: ["waivable_gap"],
      },
      remedies: true,
      action: { kind: "offer_remedies" },
    },
    // A receipt written before outcomes were stated is read by what it holds.
    { outcome: undefined, remedies: true, action: { kind: "offer_remedies" } },
    {
      outcome: undefined,
      remedies: false,
      action: { kind: "refuse", why: "hard_block" },
    },
  ])("maps $outcome.kind (remedies: $remedies) to $action.kind", ({
    outcome,
    remedies,
    action,
  }) => {
    expect(refusalAction({ outcome, remedies })).toEqual(action);
  });

  test("an outcome decides over the remedies a decision carries", () => {
    expect(
      refusalAction({ outcome: { kind: "hard_block" }, remedies: true }),
    ).toEqual({ kind: "refuse", why: "hard_block" });
  });
});

describe("refusalGuidance", () => {
  test("adds nothing while remedies stand, and the no-plan hint for a refusal nothing lifts", () => {
    expect(refusalGuidance({ kind: "offer_remedies" })).toBe("");
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
