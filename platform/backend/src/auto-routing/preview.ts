import RoutingPlanModel from "@/models/routing-plan";
import { ApiError } from "@/types";
import type {
  RoutingDecisionFeatures,
  RoutingPlan,
} from "@/types/auto-routing";
import type { AutoRoutingPreviewResponse } from "@/types/auto-routing-api";
import { decidePlanned, uniform } from "./router";
import { loadAutoRoutingSettings } from "./settings";
import { activeSourceVersion, decisionFeatures, preRunSource } from "./signals";
import { type PreRunInput, SignalSourceError } from "./signals/types";
import {
  fingerprintMatches,
  loadTrio,
  NORMAL_TIER,
  TIER_NAMES,
  type TierIndex,
  type Trio,
} from "./tiers";

/**
 * What the router would decide for a new session opening with `text`, against
 * the active plan and a fresh `u`. Nothing is stored and no re-plan is
 * requested; the scorer call is real and billed.
 */
export async function previewAutoRouting(params: {
  organizationId: string;
  text: string;
  kind: PreRunInput["kind"];
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
  const input = { firstUserText: params.text, kind: params.kind, client: null };
  const scored = await preRunSource
    .read(input, { organizationId })
    .catch((error: unknown) => {
      throw scorerFailure(error);
    });
  const version = (await activeSourceVersion()).id;
  const outcome = decideAgainstActivePlan(
    await RoutingPlanModel.findActive(organizationId),
    version,
    trio,
    decisionFeatures({ version, reading: scored, input }),
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
    expectedCostUsd: outcome.expectedCostUsd,
    scorerCostUsd: scored.costUsd,
  };
}

type Outcome = Pick<
  AutoRoutingPreviewResponse,
  "reason" | "planId" | "propensity" | "expectedCostUsd"
> & { tier: TierIndex };

const STALE: Outcome = {
  reason: "plan_stale",
  planId: null,
  tier: NORMAL_TIER,
  propensity: 1,
  expectedCostUsd: null,
};

/** The router's flow without its side effects: a stale plan falls back but requests no re-plan. */
function decideAgainstActivePlan(
  plan: RoutingPlan | null,
  scorerVersionId: string,
  trio: Trio,
  features: RoutingDecisionFeatures,
): Outcome {
  if (plan?.scorerVersionId !== scorerVersionId)
    return { ...STALE, reason: "cold_start" };
  if (!fingerprintMatches(plan.tiersFingerprint, trio)) return STALE;
  const decision = decidePlanned(plan, features, uniform());
  if (decision === null) return STALE;
  return {
    reason: "planned",
    planId: plan.id,
    tier: decision.tier_index,
    propensity: decision.propensity,
    expectedCostUsd: decision.expected_cost_usd,
  };
}

function scorerFailure(error: unknown): unknown {
  if (!(error instanceof SignalSourceError)) return error;
  switch (error.reason) {
    case "no_credentials":
      return new ApiError(400, `Session scorer unavailable: ${error.message}`);
    case "timeout":
    case "http":
    case "invalid_response":
      return new ApiError(500, `Session scorer failed: ${error.message}`);
  }
}
