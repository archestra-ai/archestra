import {
  isProviderApiKeyOptional,
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "@archestra/shared";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { getProviderEnvApiKey } from "@/config";
import { LlmProviderApiKeyModel, TeamModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";

interface ResolvedProviderApiKey {
  apiKey: string | undefined;
  source: string;
  chatApiKeyId: string | undefined;
  baseUrl: string | null;
}

/**
 * Resolve API key for a provider using priority:
 * agent's configured key > conversation > personal > team > org > environment variable
 *
 * When userId is provided: resolves via getCurrentApiKey (agent key > personal > team > org).
 * When no userId: checks org keys only.
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
  // user to link their own account.
  if (!providerRequiresPerUserCredential(provider)) {
    const envApiKey = getProviderEnvApiKey(provider);
    if (envApiKey) {
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
