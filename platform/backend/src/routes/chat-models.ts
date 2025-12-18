import {
  RouteId,
  type SupportedProvider,
  SupportedProviders,
  TimeInMs,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { ChatApiKeyModel } from "@/models";
import { isVertexAiEnabled } from "@/routes/proxy/utils/gemini-client";
import { secretManager } from "@/secretsmanager";
import { constructResponseSchema, SupportedChatProviderSchema } from "@/types";

// Response schema for models
const ChatModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: SupportedChatProviderSchema,
  createdAt: z.string().optional(),
});

interface ModelInfo {
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
}

/**
 * Fetch models from Anthropic API
 */
async function fetchAnthropicModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.chat.anthropic.baseUrl;
  const url = `${baseUrl}/v1/models?limit=100`;

  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Anthropic models",
    );
    throw new Error(`Failed to fetch Anthropic models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      display_name: string;
      created_at?: string;
    }>;
  };

  // All Anthropic models are chat models, no filtering needed
  return data.data.map((model) => ({
    id: model.id,
    displayName: model.display_name,
    provider: "anthropic" as const,
    createdAt: model.created_at,
  }));
}

/**
 * Fetch models from OpenAI API
 */
async function fetchOpenAiModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.chat.openai.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch OpenAI models",
    );
    throw new Error(`Failed to fetch OpenAI models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      created: number;
      owned_by: string;
    }>;
  };

  // Filter to only chat-compatible models
  const chatModelPrefixes = ["gpt-", "o1-", "o3-", "o4-"];
  const excludePatterns = ["-instruct", "-embedding", "-tts", "-whisper"];

  return data.data
    .filter((model) => {
      const id = model.id.toLowerCase();
      // Must start with a chat model prefix
      const hasValidPrefix = chatModelPrefixes.some((prefix) =>
        id.startsWith(prefix),
      );
      if (!hasValidPrefix) return false;

      // Must not contain excluded patterns
      const hasExcludedPattern = excludePatterns.some((pattern) =>
        id.includes(pattern),
      );
      return !hasExcludedPattern;
    })
    .map((model) => ({
      id: model.id,
      displayName: model.id, // OpenAI doesn't provide display names
      provider: "openai" as const,
      createdAt: new Date(model.created * 1000).toISOString(),
    }));
}

/**
 * Fetch models from Gemini API
 */
async function fetchGeminiModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.chat.gemini.baseUrl;
  const url = `${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`;

  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Gemini models",
    );
    throw new Error(`Failed to fetch Gemini models: ${response.status}`);
  }

  const data = (await response.json()) as {
    models: Array<{
      name: string;
      displayName: string;
      supportedGenerationMethods?: string[];
    }>;
  };

  // Filter to only models that support generateContent (chat)
  return data.models
    .filter(
      (model) =>
        model.supportedGenerationMethods?.includes("generateContent") ?? false,
    )
    .map((model) => {
      // Model name is in format "models/gemini-1.5-flash-001", extract just the model ID
      const modelId = model.name.replace("models/", "");
      return {
        id: modelId,
        displayName: model.displayName,
        provider: "gemini" as const,
      };
    });
}

/**
 * Get API key for a provider (from org default or environment)
 */
async function getProviderApiKey(
  provider: SupportedProvider,
  organizationId: string,
): Promise<string | null> {
  // Try organization default first
  const orgDefault = await ChatApiKeyModel.findOrganizationDefault(
    organizationId,
    provider,
  );

  if (orgDefault?.secretId) {
    const secret = await secretManager().getSecret(orgDefault.secretId);
    const secretValue =
      secret?.secret?.apiKey ??
      secret?.secret?.anthropicApiKey ??
      secret?.secret?.geminiApiKey ??
      secret?.secret?.openaiApiKey;

    if (secretValue) {
      return secretValue as string;
    }
  }

  // Fall back to environment variable
  switch (provider) {
    case "anthropic":
      return config.chat.anthropic.apiKey || null;
    case "openai":
      return config.chat.openai.apiKey || null;
    case "gemini":
      return config.chat.gemini.apiKey || null;
    default:
      return null;
  }
}

/**
 * Fetch models for a single provider (no caching - caching is done at route level)
 */
async function fetchModelsForProvider(
  provider: SupportedProvider,
  organizationId: string,
): Promise<ModelInfo[]> {
  const apiKey = await getProviderApiKey(provider, organizationId);

  // For Gemini with Vertex AI, we might not have an API key
  if (!apiKey && !(provider === "gemini" && isVertexAiEnabled())) {
    logger.debug(
      { provider, organizationId },
      "No API key available for provider",
    );
    return [];
  }

  try {
    switch (provider) {
      case "anthropic":
        if (!apiKey) {
          return [];
        }
        return await fetchAnthropicModels(apiKey);
      case "openai":
        if (!apiKey) {
          return [];
        }
        return await fetchOpenAiModels(apiKey);
      case "gemini":
        // For Vertex AI mode without API key, we can't fetch models dynamically
        if (!apiKey) {
          logger.debug(
            "Gemini Vertex AI mode enabled but no API key for model listing",
          );
          return [];
        }
        return await fetchGeminiModels(apiKey);
      default:
        return [];
    }
  } catch (error) {
    logger.error(
      { provider, organizationId, error },
      "Error fetching models from provider",
    );
    return [];
  }
}

const chatModelsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get available models from all configured providers
  fastify.get(
    "/api/chat/models",
    {
      schema: {
        operationId: RouteId.GetChatModels,
        description:
          "Get available LLM models from all configured providers. Models are fetched from provider APIs and cached for 12 hours.",
        tags: ["Chat"],
        querystring: z.object({
          provider: SupportedChatProviderSchema.optional(),
        }),
        response: constructResponseSchema(z.array(ChatModelSchema)),
      },
    },
    async ({ query, organizationId }, reply) => {
      const { provider } = query;

      const models = await cacheManager.wrap(
        `${CacheKey.GetChatModels}-${provider}-${organizationId}`,
        async () => {
          const providersToFetch = provider ? [provider] : SupportedProviders;

          const results = await Promise.all(
            providersToFetch.map((p) =>
              fetchModelsForProvider(p as SupportedProvider, organizationId),
            ),
          );

          const allModels = results.flat();

          logger.info(
            { organizationId, provider, modelCount: allModels.length },
            "Fetched and cached chat models",
          );

          return allModels;
        },
        { ttl: TimeInMs.Hour * 12 },
      );

      logger.debug(
        { organizationId, provider, totalModels: models.length },
        "Returning chat models",
      );

      return reply.send(models);
    },
  );
};

export default chatModelsRoutes;
