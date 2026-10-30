import { providerRequiresPerUserCredential } from "@archestra/shared";
import { LlmProviderApiKeyModel } from "@/models";
import {
  type ModelRouterAuth,
  type ModelRouterEndpoint,
  type ModelRouterUserOAuthAuth,
  modelRouterAuthenticatedUserId,
  modelRouterServesEndpoint,
  selectModelRouterCredential,
  userProviderKeyMappings,
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
 * credential ownership. Reads only, so listing and inference can share it. A
 * null `endpoint` is a platform call on a native provider route, which no
 * Model Router endpoint constrains.
 */
export async function checkAutoTierEligibility(params: {
  auth: ModelRouterAuth;
  endpoint: ModelRouterEndpoint | null;
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

  if (endpoint && !modelRouterServesEndpoint(resolution, endpoint)) {
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

/**
 * `userId` as an OAuth user of the Model Router, with every key they may use.
 * `preferredApiKeyId`, when the user may use it, is tried first for any model
 * it serves.
 */
export async function userModelRouterAuth(params: {
  organizationId: string;
  userId: string;
  preferredApiKeyId?: string | null;
}): Promise<ModelRouterUserOAuthAuth> {
  const mappings = await userProviderKeyMappings(params);
  const preferred = (mapping: { providerApiKeyId: string }) =>
    mapping.providerApiKeyId === params.preferredApiKeyId;
  return {
    authMethod: "oauth_user",
    organizationId: params.organizationId,
    userId: params.userId,
    providerApiKeys: [
      ...mappings.filter(preferred),
      ...mappings.filter((mapping) => !preferred(mapping)),
    ],
    oauthClient: null,
  };
}

/**
 * The provider key `userId` would use for `model` on a native provider route,
 * picked as the Model Router picks one for an OAuth user. A per-user
 * provider's credential is resolved at request time, so it has no key here;
 * it is found only when the user may use the model and has connected their
 * own account.
 */
export async function userKeyForModel(params: {
  organizationId: string;
  userId: string;
  model: Model;
}): Promise<{ kind: "found"; apiKeyId: string | null } | { kind: "none" }> {
  const { organizationId, userId, model } = params;
  if (providerRequiresPerUserCredential(model.provider)) {
    const [access, keys] = await Promise.all([
      checkModelTeamAccess({
        provider: model.provider,
        modelId: model.modelId,
        organizationId,
        authenticatedUserId: userId,
      }),
      LlmProviderApiKeyModel.getAvailableKeysForUser(
        organizationId,
        userId,
        [],
        model.provider,
      ),
    ]);
    return access.allowed && keys.some((key) => key.userId === userId)
      ? { kind: "found", apiKeyId: null }
      : { kind: "none" };
  }
  const eligibility = await checkAutoTierEligibility({
    auth: await userModelRouterAuth({ organizationId, userId }),
    endpoint: null,
    model,
  });
  return eligibility.eligible
    ? { kind: "found", apiKeyId: eligibility.providerApiKeyId }
    : { kind: "none" };
}
