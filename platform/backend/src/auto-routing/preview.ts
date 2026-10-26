import { randomInt } from "node:crypto";
import { decide } from "@archestra/router-rs";
import { z } from "zod";
import logger from "@/logging";
import RoutingPlanModel from "@/models/routing-plan";
import { ApiError } from "@/types";
import type { RoutingPlan, RoutingSessionFeatures } from "@/types/auto-routing";
import type { AutoRoutingPreviewResponse } from "@/types/auto-routing-api";
import { JevScorer } from "./scorer/jev-scorer";
import { ScorerError, type ScorerInput } from "./scorer/types";
import { loadAutoRoutingSettings } from "./settings";
import {
  fingerprintMatches,
  loadTrio,
  NORMAL_TIER,
  TIER_NAMES,
  type TierIndex,
  type Trio,
} from "./tiers";

const DecisionSchema = z.object({
  tier_index: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  propensity: z.number(),
});

const scorer = new JevScorer();

/**
 * What the router would decide for a new session opening with `text`, against
 * the active plan and a fresh `u`. Nothing is stored and no re-plan is
 * requested; the scorer call is real and billed.
 */
export async function previewAutoRouting(params: {
  organizationId: string;
  text: string;
  kind: ScorerInput["kind"];
}): Promise<AutoRoutingPreviewResponse> {
  const { organizationId } = params;
  const loaded = await loadTrio(await loadAutoRoutingSettings(organizationId));
  if (loaded.kind === "missing") {
    throw new ApiError(
      400,
      `Configure the ${loaded.tier} tier model before previewing auto routing.`,
    );
  }
  const { trio } = loaded;
  const scored = await scorer
    .score(
      { firstUserText: params.text, kind: params.kind, client: null },
      { organizationId, signal: new AbortController().signal },
    )
    .catch((error: unknown) => {
      throw scorerFailure(error);
    });
  const features: RoutingSessionFeatures = {
    tier_needed: scored.tierNeeded,
    p_long: scored.pLong,
    kind: params.kind,
    source: "unknown",
  };

  const outcome = decideAgainstActivePlan(
    await RoutingPlanModel.findActive(organizationId),
    trio,
    features,
  );
  const model = trio[outcome.tier];
  return {
    tierNeeded: scored.tierNeeded,
    pLong: scored.pLong,
    reason: outcome.reason,
    planId: outcome.planId,
    chosen: {
      tier: TIER_NAMES[outcome.tier],
      model: { id: model.id, provider: model.provider, modelId: model.modelId },
    },
    propensity: outcome.propensity,
    scorerCostUsd: scored.costUsd,
  };
}

type Outcome = Pick<
  AutoRoutingPreviewResponse,
  "reason" | "planId" | "propensity"
> & { tier: TierIndex };

const STALE: Outcome = {
  reason: "plan_stale",
  planId: null,
  tier: NORMAL_TIER,
  propensity: 1,
};

/** The router's flow without its side effects: a stale plan falls back but requests no re-plan. */
function decideAgainstActivePlan(
  plan: RoutingPlan | null,
  trio: Trio,
  features: RoutingSessionFeatures,
): Outcome {
  if (plan === null) return { ...STALE, reason: "cold_start" };
  if (!fingerprintMatches(plan.tiersFingerprint, trio)) return STALE;
  try {
    const decision = DecisionSchema.parse(
      JSON.parse(
        decide(JSON.stringify(plan.plan), JSON.stringify(features), uniform()),
      ),
    );
    return {
      reason: "planned",
      planId: plan.id,
      tier: decision.tier_index,
      propensity: decision.propensity,
    };
  } catch (error) {
    logger.warn(
      { err: error, organizationId: plan.organizationId, planId: plan.id },
      "[AutoRouting] Preview: serving plan cannot route",
    );
    return STALE;
  }
}

function scorerFailure(error: unknown): unknown {
  if (!(error instanceof ScorerError)) return error;
  switch (error.reason) {
    case "no_credentials":
      return new ApiError(400, `Session scorer unavailable: ${error.message}`);
    case "timeout":
    case "http":
    case "invalid_response":
      return new ApiError(500, `Session scorer failed: ${error.message}`);
  }
}

/** Uniform on [0, 1) from the CSPRNG, as the router draws it. */
function uniform(): number {
  const range = 2 ** 48 - 1;
  return randomInt(range) / range;
}
