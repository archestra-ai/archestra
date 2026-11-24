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
  /**
   * Nothing the agent or a person can do lifts it; `unstated` is a ruling
   * that says neither why nor which remedies it holds.
   */
  | { kind: "refuse"; why: "integrity" | "hard_block" | "unstated" }
  /** The call was not judged; asking again may or may not help. */
  | { kind: "refuse_unjudged"; retry: RetryHint };

/** The refusal fields of a runtime decision, as its wire spells them. */
export const RefusalOutcomeFields = {
  outcomes: z.array(OutcomeKindSchema).optional(),
  deciding: OutcomeKindSchema.optional(),
  retry: RetryHintSchema.optional(),
};

/** A decision that admits or answers carries no refusal fields. */
export const NoRefusalOutcomeFields = {
  outcomes: z.never().optional(),
  deciding: z.never().optional(),
  retry: z.never().optional(),
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
        if (retry !== undefined)
          return { problem: `a retry hint on ${deciding}` };
        return remedies
          ? { problem: `${deciding} beside offers or reviews` }
          : { outcome: { kind: deciding } };
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
 * read by what it lists: an offer or a review is a remedy, an empty offer
 * list is a hard block, and no list says nothing.
 */
export function refusalAction(params: {
  outcome: RefusalOutcome | undefined;
  offers: readonly unknown[] | undefined;
  review: readonly unknown[] | undefined;
}): RefusalAction {
  const { outcome, offers, review } = params;
  if (outcome === undefined) {
    if (offers?.length || review?.length) return { kind: "offer_remedies" };
    return offers === undefined
      ? { kind: "refuse", why: "unstated" }
      : { kind: "refuse", why: "hard_block" };
  }
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
 * The action a retained `deny_call` receipt supports, read from its own
 * fields; `undefined` for any other receipt or one that contradicts itself.
 */
export function receiptRefusalAction(
  receipt: unknown,
): RefusalAction | undefined {
  const parsed = DenyReceiptSchema.safeParse(receipt);
  if (!parsed.success) return undefined;
  const { offers, review } = parsed.data;
  const stated = statedRefusalOutcome(
    parsed.data,
    Boolean(offers?.length || review?.length),
  );
  if ("problem" in stated) return undefined;
  return refusalAction({ outcome: stated.outcome, offers, review });
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
      return action.why === "unstated" ? "" : NO_REMEDY_PLAN_HINT;
    case "refuse_unjudged":
      return UNJUDGED_CALL_GUIDANCE[action.retry];
  }
}

/**
 * What the host adds to output the runtime withheld from a call that already
 * ran: a check it could not finish says so, and never asks for the call
 * again, which would repeat what it did.
 */
export function withheldOutputGuidance(action: RefusalAction): string {
  return action.kind === "refuse_unjudged"
    ? UNJUDGED_OUTPUT_GUIDANCE[action.retry]
    : "";
}

// ===

const DenyReceiptSchema = z.object({
  decision: z.literal("deny_call"),
  ...RefusalOutcomeFields,
  offers: z.array(z.object({ offer_id: z.string().min(1) })).optional(),
  review: z.array(z.object({ offer_id: z.string().min(1) })).optional(),
});

const UNJUDGED_CALL_GUIDANCE: Record<RetryHint, string> = {
  later:
    "\n\n[appa] Make the same call again later; the check may complete then. If it fails the same way again, stop and tell the user that Guardrails could not check this call.",
  after_repair:
    "\n\n[appa] Retrying will not help until an administrator fixes the Guardrails setup. Stop and tell the user that Guardrails could not check this call.",
};

const UNJUDGED_OUTPUT_GUIDANCE: Record<RetryHint, string> = {
  later:
    "\n\n[appa] The call already ran, but Guardrails could not finish checking its output, so the output is withheld. Do not make the call again: it would run again. Tell the user that Guardrails could not check this output yet.",
  after_repair:
    "\n\n[appa] The call already ran, but Guardrails cannot check its output until an administrator fixes the Guardrails setup, so the output is withheld. Do not make the call again: it would run again. Tell the user that Guardrails could not check this output.",
};

function isRemedy(outcome: OutcomeKind): outcome is Remedy {
  return (
    outcome === "agent_choice" ||
    outcome === "waivable_gap" ||
    outcome === "consent"
  );
}
