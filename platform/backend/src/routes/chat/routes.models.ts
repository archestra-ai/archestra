```typescript
import {
  MINIMAX_MODELS,
  PERPLEXITY_MODELS,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  RouteId,
  type SupportedProvider,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import config from "@/config";
import logger from "@/logging";
import {
  ApiKeyModelModel,
  ChatApiKeyModel,
  ModelModel,
  TeamModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import { systemKeyManager } from "@/services/system-key-manager";
import {
  type Anthropic,
  ApiError,
  constructResponseSchema,
  type Gemini,
  type ModelCapabilities,
  ModelCapabilitiesSchema,
  ModelWithApiKeysSchema,
  type OpenAi,
  SelectModelSchema,
  SupportedChatProviderSchema,
  UpdateModelPricingSchema,
  UuidIdSchema,
} from "@/types";

// ... existing code

/**
 * Fetch models from x.ai (Grok) API
 */
async function fetchXaiGrokModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.xaiGrok.baseUrl;
  const url = `${baseUrl}/v1/models?limit=100`;

  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "xai-grok-version": "2023-06-01",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch x.ai (Grok) models",
    );
    throw new Error(`Failed to fetch x.ai (Grok) models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: XaiGrok.Types.Model[];
  };

  // All x.ai (Grok) models are chat models, no filtering needed
  return data.data.map((model) => ({
    id: model.id,
    displayName: model.display_name,
    provider: "xai-grok" as const,
    createdAt: model.created_at,
  }));
}

// ... existing code