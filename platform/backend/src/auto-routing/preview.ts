import RoutingPlanModel from "@/models/routing-plan";
import { ApiError } from "@/types";
import type {
  AutoRoutingPreviewBody,
  AutoRoutingPreviewResponse,
} from "@/types/auto-routing-api";
import { firstUserText } from "./first-user-text";
import { selectTier, uniform } from "./router";
import { scoringContext } from "./scoring-context";
import { loadAutoRouter } from "./settings";
import { activeSourceVersion, decisionFeatures, preRunSource } from "./signals";
import { type PreRunInput, SignalSourceError } from "./signals/types";
import { loadTrio, TIER_NAMES } from "./tiers";

/**
 * What the router would decide for a new session opening with `text`, against
 * the active plan and a fresh `u`. Nothing is stored and no re-plan is
 * requested; the scorer call is real and billed.
 */
export async function previewAutoRouting(
  params: AutoRoutingPreviewBody & { organizationId: string; routerId: string },
): Promise<AutoRoutingPreviewResponse> {
  const { organizationId } = params;
  const router = await loadAutoRouter(organizationId, params.routerId);
  const source =
    "request" in params
      ? {
          firstUserText: firstUserText(
            params.request.input !== undefined
              ? "responses"
              : "chat_completions",
            params.request,
          ),
          client: params.client ?? null,
          ...scoringContext(params.request),
        }
      : { firstUserText: params.text, client: null };
  if (source.firstUserText === null) {
    throw new ApiError(
      400,
      "The request must contain an opening user message with text.",
    );
  }
  const input: PreRunInput = {
    ...source,
    firstUserText: source.firstUserText,
  };
  const loaded = await loadTrio(router);
  if (loaded.kind === "missing") {
    throw new ApiError(
      400,
      `Configure the ${loaded.tier} tier model before previewing auto routing.`,
    );
  }
  const { trio } = loaded;
  const scored = await preRunSource(router.scorerModel)
    .read(input, { organizationId, apiKeyId: router.scorerApiKeyId })
    .catch((error: unknown) => {
      throw scorerFailure(error);
    });
  const version = (await activeSourceVersion(router.scorerModel)).id;
  // No re-plan is requested for a stale plan: preview has no side effects.
  const outcome = selectTier({
    active: await RoutingPlanModel.findActive(router.id),
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
    case "input_too_large":
      return new ApiError(400, error.message);
    case "no_credentials":
      return new ApiError(400, `Session scorer unavailable: ${error.message}`);
    case "timeout":
    case "http":
    case "invalid_response":
      return new ApiError(500, `Session scorer failed: ${error.message}`);
  }
}
