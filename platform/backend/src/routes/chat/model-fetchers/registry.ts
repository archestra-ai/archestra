import type { SupportedProvider } from "@shared";
import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import config, { getProviderEnvApiKey } from "@/config";
import logger from "@/logging";
import { LlmProviderApiKeyModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { fetchBedrockModelsViaIam } from "./bedrock";
import { fetchGeminiModelsViaVertexAi } from "./gemini";
import { modelFetchers } from "./index";
import { type ModelInfo, PLACEHOLDER_API_KEY } from "./types";

export async function testProviderApiKey(
  provider: SupportedProvider,
  apiKey: string,
  baseUrl?: string | null,
): Promise<void> {
  const models = await modelFetchers[provider](apiKey, baseUrl);
  if (models.length === 0) {
    logger.error({ provider }, "testProviderApiKey: Models list is empty");
    throw new Error("Models list is empty");
  }
}

export async function fetchModelsForProvider(params: {
  provider: SupportedProvider;
  organizationId: string;
  userId: string;
  userTeamIds: string[];
}): Promise<ModelInfo[]> {
  const { provider, organizationId, userId, userTeamIds } = params;
  const apiKey = await getProviderApiKey({
    provider,
    organizationId,
    userId,
    userTeamIds,
  });

  const vertexAiEnabled = provider === "gemini" && isVertexAiEnabled();
  const bedrockIamEnabled = provider === "bedrock" && isBedrockIamAuthEnabled();
  const isKeylessProviderEnabled =
    (provider === "vllm" && config.llm.vllm.enabled) ||
    (provider === "ollama" && config.llm.ollama.enabled);
  const isBedrockEnabled = provider === "bedrock" && config.llm.bedrock.enabled;

  if (
    !apiKey &&
    !vertexAiEnabled &&
    !bedrockIamEnabled &&
    !isKeylessProviderEnabled &&
    !isBedrockEnabled
  ) {
    logger.debug(
      { provider, organizationId },
      "No API key available for provider",
    );
    return [];
  }

  try {
    let models: ModelInfo[];

    if (provider === "gemini" && vertexAiEnabled) {
      models = await fetchGeminiModelsViaVertexAi();
    } else if (provider === "bedrock" && bedrockIamEnabled) {
      models = await fetchBedrockModelsViaIam();
    } else {
      models = await modelFetchers[provider](apiKey || PLACEHOLDER_API_KEY);
    }

    logger.info(
      { provider, modelCount: models.length },
      "fetchModelsForProvider:fetched models from provider",
    );

    return models;
  } catch (error) {
    logger.error(
      {
        provider,
        organizationId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "fetchModelsForProvider:error fetching models from provider",
    );
    return [];
  }
}

async function getProviderApiKey(params: {
  provider: SupportedProvider;
  organizationId: string;
  userId: string;
  userTeamIds: string[];
}): Promise<string | null> {
  const { provider, organizationId, userId, userTeamIds } = params;

  const apiKey = await LlmProviderApiKeyModel.getCurrentApiKey({
    organizationId,
    userId,
    userTeamIds,
    provider,
    conversationId: null,
  });

  if (apiKey?.secretId) {
    const secretValue = await getSecretValueForLlmProviderApiKey(
      apiKey.secretId,
    );

    if (secretValue) {
      return secretValue as string;
    }
  }

  return getProviderEnvApiKey(provider) ?? null;
}
