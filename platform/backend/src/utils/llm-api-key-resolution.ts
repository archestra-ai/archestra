import {
  isProviderApiKeyOptional,
  isSubscriptionCredential,
  providerRequiresPerUserCredential,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindFromCredential,
} from "@archestra/shared";
import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { getProviderEnvApiKey } from "@/config";
import { LlmProviderApiKeyModel, TeamModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";

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
 */
export async function resolveProviderApiKey(params: {
  organizationId: string;
  userId?: string;
  provider: SupportedProvider;
  conversationId?: string | null;
  agentLlmApiKeyId?: string | null;
}): Promise<ResolvedProviderApiKey> {
  const { organizationId, userId, provider, conversationId, agentLlmApiKeyId } =
    params;

  let resolvedApiKey: {
    id: string;
    secretId: string | null;
    scope: string;
    userId: string | null;
    baseUrl: string | null;
    inferenceBaseUrl: string | null;
  } | null = null;

  if (userId) {
    const userTeamIds = await TeamModel.getUserTeamIds(userId);
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
        anthropicWifEnabled: anthropicWorkloadIdentity.isEnabled(),
      })
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
