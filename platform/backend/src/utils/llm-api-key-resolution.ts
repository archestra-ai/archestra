import {
  isProviderApiKeyOptional,
  isSubscriptionCredential,
  providerDisplayNames,
  providerHasEndpointLocalModels,
  providerRequiresPerUserCredential,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindFromCredential,
} from "@archestra/shared";
import { isAnthropicKeylessAuthEnabled } from "@/clients/anthropic-keyless-auth";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import config, { getProviderEnvApiKey } from "@/config";
import logger from "@/logging";
import { LlmProviderApiKeyModel, ModelModel, TeamModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import type { LlmProviderApiKey } from "@/types";

interface ResolvedProviderApiKey {
  apiKey: string | undefined;
  source: string;
  chatApiKeyId: string | undefined;
  baseUrl: string | null;
  /**
   * Set when apiKey is undefined BECAUSE the acting user must connect their
   * own per-user credential: resolution landed on a subscription key they don't
   * own and they have no subscription of their own.
   * Interactive surfaces (model creation) turn this into the typed
   * LlmProviderAuthRequiredError so the user gets a "connect your account"
   * prompt; best-effort flows (title generation, compaction) treat it like
   * any other missing key and skip.
   */
  authRequired?: { provider: SupportedProvider; providerLabel: string };
}

/**
 * Resolve API key for a provider using priority:
 * conversation > agent's configured key > personal > team > org > environment variable
 *
 * When userId is provided: resolves via getCurrentApiKey (conversation > agent key > personal > team > org).
 * When no userId: checks org keys only.
 *
 * A subscription credential is per-user regardless of how it was reached: it is
 * only ever returned to its owner. When resolution lands on someone else's
 * subscription key, the acting user's own subscription key of the same kind is
 * substituted; without one, no key is returned and `authRequired` says why.
 *
 * `modelName` refines the endpoint, not the credential: for providers whose
 * keys are servers rather than accounts (vLLM, Ollama, Azure, Archestra), a key
 * only reaches the models its own server hosts, so a key that cannot serve the
 * requested model is replaced by one that can. See `findKeyServingModel`.
 */
export async function resolveProviderApiKey(params: {
  organizationId: string;
  userId?: string;
  provider: SupportedProvider;
  conversationId?: string | null;
  agentLlmApiKeyId?: string | null;
  /** Model the caller is about to run, when known at resolution time. */
  modelName?: string | null;
}): Promise<ResolvedProviderApiKey> {
  const {
    organizationId,
    userId,
    provider,
    conversationId,
    agentLlmApiKeyId,
    modelName,
  } = params;

  let resolvedApiKey: {
    id: string;
    secretId: string | null;
    scope: string;
    userId: string | null;
    baseUrl: string | null;
    inferenceBaseUrl: string | null;
  } | null = null;
  let userTeamIds: string[] = [];

  if (userId) {
    userTeamIds = await TeamModel.getUserTeamIds(userId);
    resolvedApiKey = await LlmProviderApiKeyModel.getCurrentApiKey({
      organizationId,
      userId,
      userTeamIds,
      provider,
      conversationId: conversationId ?? null,
      agentLlmApiKeyId,
    });
  } else if (!providerRequiresPerUserCredential(provider)) {
    // Per-user providers have no org-scope key to fall back to, and there's no
    // acting user to resolve a personal key — leave it unresolved.
    resolvedApiKey = await LlmProviderApiKeyModel.findByScope(
      organizationId,
      provider,
      "org",
    );
  }

  resolvedApiKey = await preferKeyServingModel({
    organizationId,
    userId,
    userTeamIds,
    provider,
    modelName,
    agentLlmApiKeyId,
    resolved: resolvedApiKey,
  });

  if (resolvedApiKey) {
    if (resolvedApiKey.secretId) {
      const secretValue = await getSecretValueForLlmProviderApiKey(
        resolvedApiKey.secretId,
      );
      if (secretValue) {
        // A subscription credential is one person's vendor account.
        // getCurrentApiKey's agent/conversation paths intentionally skip user
        // access checks ("permission flows through agent access"), which is
        // fine for shared org keys but must never hand one user's subscription
        // to another — same contract as the per-user providers
        // (GitHub/Microsoft Copilot), enforced here at the key level because
        // the marker only exists on the decrypted secret.
        const subscriptionKind = subscriptionKindFromCredential(
          secretValue as string,
        );
        // A marker belonging to another provider's subscription means the
        // stored value was corrupted or swapped (e.g. rotated out of band —
        // nothing re-validates a BYOS vault value). No adapter can use it:
        // this provider's adapter would send the encoded refresh token
        // upstream as a raw bearer. Refuse resolution outright — even for the
        // owner's own key.
        if (
          subscriptionKind &&
          SUBSCRIPTION_CREDENTIALS[subscriptionKind].provider !== provider
        ) {
          logger.warn(
            {
              provider,
              markerProvider:
                SUBSCRIPTION_CREDENTIALS[subscriptionKind].provider,
              llmProviderApiKeyId: resolvedApiKey.id,
            },
            "Refusing subscription credential whose marker belongs to another provider",
          );
          return {
            apiKey: undefined,
            source: resolvedApiKey.scope,
            chatApiKeyId: undefined,
            baseUrl: null,
            authRequired: {
              provider,
              providerLabel: providerDisplayNames[provider],
            },
          };
        }
        if (
          subscriptionKind &&
          !(
            userId !== undefined &&
            resolvedApiKey.scope === "personal" &&
            resolvedApiKey.userId === userId
          )
        ) {
          return await substituteOwnSubscriptionKey({
            organizationId,
            userId,
            kind: subscriptionKind,
          });
        }
        return {
          apiKey: secretValue as string,
          source: resolvedApiKey.scope,
          chatApiKeyId: resolvedApiKey.id,
          baseUrl: resolvedApiKey.inferenceBaseUrl ?? resolvedApiKey.baseUrl,
        };
      }
    }

    if (
      isProviderApiKeyOptional({
        provider,
        azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
        anthropicKeylessAuthEnabled: isAnthropicKeylessAuthEnabled(),
      }) ||
      (provider === "gemini" && config.llm.gemini.vertexAi.enabled) ||
      (provider === "bedrock" && config.llm.bedrock.iamAuthEnabled)
    ) {
      return {
        apiKey: undefined,
        source: resolvedApiKey.scope,
        chatApiKeyId: resolvedApiKey.id,
        baseUrl: resolvedApiKey.inferenceBaseUrl ?? resolvedApiKey.baseUrl,
      };
    }
  }

  // Per-user providers (GitHub Copilot) must never fall back to the shared env
  // token — that single token would be used by every user, which is exactly the
  // sharing we're preventing. Leave apiKey undefined so the caller prompts the
  // user to link their own account. A subscription credential in the env var is
  // the same per-user token shared deployment-wide, so it is refused too.
  if (!providerRequiresPerUserCredential(provider)) {
    const envApiKey = getProviderEnvApiKey(provider);
    if (envApiKey && !isSubscriptionCredential(envApiKey)) {
      return {
        apiKey: envApiKey,
        source: "environment",
        chatApiKeyId: undefined,
        baseUrl: null,
      };
    }
  }

  return {
    apiKey: undefined,
    source: "environment",
    chatApiKeyId: undefined,
    baseUrl: null,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Swap the ownership-ranked key for one whose endpoint actually serves the
 * requested model, when the two disagree.
 *
 * Only applies to providers whose keys are servers rather than accounts
 * (`providerHasEndpointLocalModels`): there, an endpoint that does not host the
 * model cannot answer for it at all, so keeping the higher-ranked key is a
 * guaranteed upstream 404. For credential-style providers every key reaches the
 * same catalog, and swapping would silently move spend to another account — so
 * they are left alone.
 *
 * Conservative in both directions: the ranked key is kept whenever it already
 * serves the model, and also whenever nothing is known about which endpoints do
 * (a model that was never synced, e.g. one discovered through the LLM proxy).
 */
async function preferKeyServingModel<
  T extends { id: string; scope: string } | null,
>(params: {
  organizationId: string;
  userId?: string;
  userTeamIds: string[];
  provider: SupportedProvider;
  modelName?: string | null;
  agentLlmApiKeyId?: string | null;
  resolved: T;
}): Promise<T | LlmProviderApiKey> {
  const { provider, modelName, resolved } = params;

  if (!modelName || !providerHasEndpointLocalModels(provider)) {
    return resolved;
  }

  const model = await ModelModel.findByProviderAndModelId(provider, modelName);
  if (!model) {
    return resolved;
  }

  const servingKey = await LlmProviderApiKeyModel.findKeyServingModel({
    organizationId: params.organizationId,
    userId: params.userId,
    userTeamIds: params.userTeamIds,
    provider,
    modelDbId: model.id,
    agentLlmApiKeyId: params.agentLlmApiKeyId,
  });

  if (!servingKey || servingKey.id === resolved?.id) {
    return resolved;
  }

  logger.info(
    {
      provider,
      model: modelName,
      from: resolved?.id,
      to: servingKey.id,
    },
    "Routing to the provider key whose endpoint serves the requested model",
  );
  return servingKey;
}

/**
 * Resolution landed on a subscription credential the acting user does not own
 * (an agent-attached key on a shared agent, a conversation key, or a team/org
 * key that shouldn't exist). Substitute the acting user's OWN subscription key
 * of the same kind; without one, return no key with the `authRequired` marker
 * so interactive surfaces prompt them to connect their own account instead of
 * riding on someone else's subscription.
 */
async function substituteOwnSubscriptionKey(params: {
  organizationId: string;
  userId: string | undefined;
  kind: SubscriptionCredentialKind;
}): Promise<ResolvedProviderApiKey> {
  const ownKey = params.userId
    ? await LlmProviderApiKeyModel.findPersonalSubscriptionKey({
        organizationId: params.organizationId,
        userId: params.userId,
        kind: params.kind,
      })
    : null;

  if (!ownKey) {
    const { provider, label } = SUBSCRIPTION_CREDENTIALS[params.kind];
    return {
      apiKey: undefined,
      // The credential this resolution refused to share can only ever come
      // from the acting user's personal scope.
      source: "personal",
      chatApiKeyId: undefined,
      baseUrl: null,
      authRequired: { provider, providerLabel: label },
    };
  }

  return {
    apiKey: ownKey.apiKeyValue,
    source: ownKey.apiKey.scope,
    chatApiKeyId: ownKey.apiKey.id,
    baseUrl: ownKey.apiKey.inferenceBaseUrl ?? ownKey.apiKey.baseUrl,
  };
}
