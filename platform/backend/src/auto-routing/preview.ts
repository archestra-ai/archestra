import RoutingPlanModel from "@/models/routing-plan";
import { ApiError } from "@/types";
import type { AutoRoutingPreviewResponse } from "@/types/auto-routing-api";
import { selectTier, uniform } from "./router";
import { loadAutoRoutingSettings } from "./settings";
import { activeSourceVersion, decisionFeatures, preRunSource } from "./signals";
import { type PreRunInput, SignalSourceError } from "./signals/types";
import { loadTrio, TIER_NAMES } from "./tiers";

/**
 * What the router would decide for a new session opening with `text`, against
 * the active plan and a fresh `u`. Nothing is stored and no re-plan is
 * requested; the scorer call is real and billed.
 */
export async function previewAutoRouting(params: {
  organizationId: string;
  text: string;
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
  const input: PreRunInput = { firstUserText: params.text, client: null };
  const scored = await preRunSource
    .read(input, { organizationId })
    .catch((error: unknown) => {
      throw scorerFailure(error);
    });
  const version = (await activeSourceVersion()).id;
  // No re-plan is requested for a stale plan: preview has no side effects.
  const outcome = selectTier({
    active: await RoutingPlanModel.findActive(organizationId),
    scorerVersionId: version,
    trio,
    features: decisionFeatures({ version, reading: scored, input }),
    u: uniform(),
  });
  const model = trio[outcome.tier];
  return {
    tierNeeded: scored.tierNeeded,
    pLong: scored.pLong,
    reason: outcome.reason,
    planId: outcome.plan?.id ?? null,
    chosen: {
      tier: TIER_NAMES[outcome.tier],
      model: { id: model.id, provider: model.provider, modelId: model.modelId },
    },
    propensity: outcome.propensity,
    expectedCostUsd: outcome.decision?.expected_cost_usd ?? null,
    scorerCostUsd: scored.costUsd,
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
