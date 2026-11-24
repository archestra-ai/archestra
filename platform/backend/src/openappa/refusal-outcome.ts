import { z } from "zod";
import { NO_REMEDY_PLAN_HINT } from "./no-remedy-plan-hint";

const OutcomeKindSchema = z.enum([
  "integrity",
  "hard_block",
  "missing_fact",
  "agent_choice",
  "waivable_gap",
  "consent",
]);
type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

const RetryHintSchema = z.enum(["later", "after_repair"]);

/**
 * Why the runtime refused an operation, in the typed fields its decision
 * carries (`outcomes`, `deciding`, `retry`). The host branches on these
 * fields only, never on the refusal's text.
 */
export type RefusalOutcome =
  /** The call, the event or the deployment breaks its contract. */
  | { kind: "integrity" }
  /** No remedy lifts the block. */
  | { kind: "hard_block" }
  /** A fact the check reads was not obtained; no plan is offered. */
  | { kind: "missing_fact"; retry: RetryHint }
  /** Offers can lift the block: `deciding` is what the cheapest one asks. */
  | { kind: "remediable"; deciding: Remedy; held: readonly Remedy[] };

export type RetryHint = z.infer<typeof RetryHintSchema>;
type Remedy = Extract<OutcomeKind, "agent_choice" | "waivable_gap" | "consent">;

/** What the host does with a refused call. */
export type RefusalAction =
  /** The offers are the agent's to act on, so the remedy tools must reach it. */
  | { kind: "offer_remedies" }
  /** Nothing the agent or a person can do lifts it. */
  | { kind: "refuse"; why: "integrity" | "hard_block" }
  /** The call was not judged; asking again may or may not help. */
  | { kind: "refuse_unjudged"; retry: RetryHint };

/** The refusal fields of a runtime decision, as its wire spells them. */
export const RefusalOutcomeFields = {
  outcomes: z.array(OutcomeKindSchema).optional(),
  deciding: OutcomeKindSchema.optional(),
  retry: RetryHintSchema.optional(),
};

/**
 * The outcome a decision states, `undefined` when it states none (a receipt
 * written before the runtime stated outcomes), or a problem when the fields
 * break the runtime's own invariants: an integrity fault, a hard block and a
 * missing fact stand alone, only a missing fact carries a retry hint and no
 * offers, and the deciding remedy is among those held.
 */
export function statedRefusalOutcome(
  fields: {
    outcomes?: readonly OutcomeKind[];
    deciding?: OutcomeKind;
    retry?: RetryHint;
  },
  remedies: boolean,
): { outcome: RefusalOutcome | undefined } | { problem: string } {
  const { outcomes, deciding, retry } = fields;
  if (outcomes === undefined && deciding === undefined && retry === undefined)
    return { outcome: undefined };
  if (outcomes === undefined || deciding === undefined)
    return { problem: "refusal outcomes without their deciding one" };
  const [alone, ...rest] = outcomes;
  if (rest.length === 0 && alone === deciding) {
    switch (deciding) {
      case "integrity":
      case "hard_block":
        return retry === undefined
          ? { outcome: { kind: deciding } }
          : { problem: `a retry hint on ${deciding}` };
      case "missing_fact":
        if (retry === undefined)
          return { problem: "a missing fact without its retry hint" };
        return remedies
          ? { problem: "a missing fact beside offers or reviews" }
          : { outcome: { kind: "missing_fact", retry } };
    }
  }
  if (retry !== undefined)
    return { problem: "a retry hint on anything but a missing fact alone" };
  const held = outcomes.filter(isRemedy);
  if (!isRemedy(deciding) || held.length !== outcomes.length)
    return {
      problem:
        "an integrity fault, a hard block or a missing fact beside other outcomes",
    };
  if (!held.includes(deciding))
    return { problem: "a deciding outcome its outcomes do not hold" };
  return {
    outcome: { kind: "remediable", deciding, held: [...new Set(held)] },
  };
}

/**
 * The host's action on a refused call. A refusal that states no outcome is
 * read by what it carries: offers, reviews or offers it does not list are
 * remedies; a ruling that lists none is a hard block.
 */
export function refusalAction(params: {
  outcome: RefusalOutcome | undefined;
  remedies: boolean;
}): RefusalAction {
  const { outcome } = params;
  if (outcome === undefined)
    return params.remedies
      ? { kind: "offer_remedies" }
      : { kind: "refuse", why: "hard_block" };
  switch (outcome.kind) {
    case "integrity":
    case "hard_block":
      return { kind: "refuse", why: outcome.kind };
    case "missing_fact":
      return { kind: "refuse_unjudged", retry: outcome.retry };
    case "remediable":
      return { kind: "offer_remedies" };
  }
}

/**
 * What the host adds to the runtime's ruling for the model: nothing while
 * remedies stand, the no-plan hint for a refusal nothing lifts, and whether
 * to ask again for a call that was not judged.
 */
export function refusalGuidance(action: RefusalAction): string {
  switch (action.kind) {
    case "offer_remedies":
      return "";
    case "refuse":
      return NO_REMEDY_PLAN_HINT;
    case "refuse_unjudged":
      return UNJUDGED_CALL_GUIDANCE[action.retry];
  }
}

// ===

const UNJUDGED_CALL_GUIDANCE: Record<RetryHint, string> = {
  later:
    "\n\n[appa] Make the same call again later; the check may complete then. If it fails the same way again, stop and tell the user that Guardrails could not check this call.",
  after_repair:
    "\n\n[appa] Retrying will not help until an administrator fixes the Guardrails setup. Stop and tell the user that Guardrails could not check this call.",
};

function isRemedy(outcome: OutcomeKind): outcome is Remedy {
  return (
    outcome === "agent_choice" ||
    outcome === "waivable_gap" ||
    outcome === "consent"
  );
}
