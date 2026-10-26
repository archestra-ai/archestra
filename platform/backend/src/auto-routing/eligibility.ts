import {
  type ModelRouterAuth,
  type ModelRouterEndpoint,
  modelRouterAuthenticatedUserId,
  modelRouterServesEndpoint,
  selectModelRouterCredential,
} from "@/routes/proxy/model-router-access";
import {
  buildRoutableModelId,
  type ModelRouterResolution,
  resolveModelRoute,
} from "@/routes/proxy/model-router-resolver";
import { checkModelTeamAccess } from "@/routes/proxy/utils/model-team-access";
import { ApiError, type Model } from "@/types";

export type EligibleTier = {
  eligible: true;
  routedModel: string;
  /** The provider instance the request would be sent to. */
  providerApiKeyId: string;
};
export type IneligibleTier = {
  eligible: false;
  routedModel: string;
  reason: string;
};
export type TierEligibility = EligibleTier | IneligibleTier;

/**
 * Whether a Model Router request for `model` on `endpoint` would pass every
 * gate the router and the proxy apply before forwarding it: model resolution
 * through the credential's linked keys, the `use` grant, endpoint support and
 * credential ownership. Reads only, so listing and inference can share it.
 */
export async function checkAutoTierEligibility(params: {
  auth: ModelRouterAuth;
  endpoint: ModelRouterEndpoint;
  model: Model;
}): Promise<TierEligibility> {
  const { auth, endpoint, model } = params;
  const routedModel = buildRoutableModelId(model);
  const denied = (reason: string): TierEligibility => ({
    eligible: false,
    routedModel,
    reason,
  });

  let resolution: ModelRouterResolution;
  try {
    resolution = await resolveModelRoute({
      requestedModel: routedModel,
      allowedProviders: new Set(auth.providerApiKeys.map((m) => m.provider)),
      allowedApiKeyIds: auth.providerApiKeys.map((m) => m.providerApiKeyId),
    });
  } catch (error) {
    if (error instanceof ApiError) return denied(error.message);
    throw error;
  }

  const access = await checkModelTeamAccess({
    provider: resolution.provider,
    modelId: resolution.modelId,
    organizationId: auth.organizationId,
    authenticatedUserId: modelRouterAuthenticatedUserId(auth),
  });
  if (!access.allowed) return denied(access.message);

  if (!modelRouterServesEndpoint(resolution, endpoint)) {
    return denied(`the model is not served on the ${endpoint} endpoint`);
  }

  const credential = await selectModelRouterCredential({ auth, resolution });
  if (credential.kind === "denied") return denied(credential.error.message);

  return {
    eligible: true,
    routedModel,
    providerApiKeyId: credential.mappedApiKey.providerApiKeyId,
  };
}
