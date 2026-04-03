import {
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  type SupportedProvider,
} from "@shared";
import { getProviderEnvApiKey } from "@/config";
import { LlmProviderApiKeyModel, TeamModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";

export interface ResolvedProviderApiKey {
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
  } else {
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
          baseUrl: resolvedApiKey.baseUrl,
        };
      }
    }

    if (PROVIDERS_WITH_OPTIONAL_API_KEY.has(provider)) {
      return {
        apiKey: undefined,
        source: resolvedApiKey.scope,
        chatApiKeyId: resolvedApiKey.id,
        baseUrl: resolvedApiKey.baseUrl,
      };
    }
  }

  const envApiKey = getProviderEnvApiKey(provider);
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      source: "environment",
      chatApiKeyId: undefined,
      baseUrl: null,
    };
  }

  return {
    apiKey: undefined,
    source: "environment",
    chatApiKeyId: undefined,
    baseUrl: null,
  };
}
