/**
 * Unified LLM Proxy Routes — OpenAI-compatible
 *
 * Provides a single /v1/unified/ endpoint that:
 * - GET /v1/unified/models  — aggregates models from all configured providers in OpenAI format
 * - POST /v1/unified/chat/completions — auto-routes to the right provider based on the model
 *   in the request body, and always returns an OpenAI-format response
 *
 * This allows clients that only speak OpenAI format to access any provider configured
 * in the platform without knowing which provider hosts a given model.
 *
 * Supported providers for auto-routing:
 *   openai, cerebras, mistral, perplexity, groq, xai, openrouter, vllm, ollama,
 *   zhipuai, deepseek, minimax, azure
 *
 * Non-OpenAI-wire-format providers (anthropic, gemini, cohere, bedrock) appear in
 * the /models list but are not auto-routed via the unified chat endpoint — use their
 * dedicated proxy endpoints instead.
 */
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import {
  constructResponseSchema,
  type LLMProvider,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import {
  azureAdapterFactory,
  cerebrasAdapterFactory,
  deepseekAdapterFactory,
  groqAdapterFactory,
  minimaxAdapterFactory,
  mistralAdapterFactory,
  ollamaAdapterFactory,
  openaiAdapterFactory,
  openrouterAdapterFactory,
  perplexityAdapterFactory,
  vllmAdapterFactory,
  xaiAdapterFactory,
  zhipuaiAdapterFactory,
} from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

// ============================================================================
// Types
// ============================================================================

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type OpenAiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type OpenAiHeaders = OpenAi.Types.ChatCompletionsHeaders;
type OpenAiStreamChunk = OpenAi.Types.ChatCompletionChunk;

type OpenAiAdapterFactory = LLMProvider<
  OpenAiRequest,
  OpenAiResponse,
  OpenAiMessages,
  OpenAiStreamChunk,
  OpenAiHeaders
>;

// ============================================================================
// Adapter registry — maps provider name → OpenAI-wire-format adapter factory.
// Only providers that accept the OpenAI ChatCompletions wire format are included.
// Providers such as anthropic, gemini, cohere, and bedrock require format
// translation and are deliberately excluded from the auto-routing map.
// ============================================================================

const OPENAI_COMPATIBLE_ADAPTERS: Record<string, OpenAiAdapterFactory> = {
  openai: openaiAdapterFactory,
  cerebras: cerebrasAdapterFactory as unknown as OpenAiAdapterFactory,
  mistral: mistralAdapterFactory as unknown as OpenAiAdapterFactory,
  perplexity: perplexityAdapterFactory as unknown as OpenAiAdapterFactory,
  groq: groqAdapterFactory as unknown as OpenAiAdapterFactory,
  xai: xaiAdapterFactory as unknown as OpenAiAdapterFactory,
  openrouter: openrouterAdapterFactory as unknown as OpenAiAdapterFactory,
  vllm: vllmAdapterFactory as unknown as OpenAiAdapterFactory,
  ollama: ollamaAdapterFactory as unknown as OpenAiAdapterFactory,
  zhipuai: zhipuaiAdapterFactory as unknown as OpenAiAdapterFactory,
  deepseek: deepseekAdapterFactory as unknown as OpenAiAdapterFactory,
  minimax: minimaxAdapterFactory as unknown as OpenAiAdapterFactory,
  azure: azureAdapterFactory as unknown as OpenAiAdapterFactory,
};

// ============================================================================
// Route plugin
// ============================================================================

const unifiedProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/unified`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const MODELS_SUFFIX = "/models";

  logger.info("[UnifiedProxy] Registering unified multi-provider routes");

  // --------------------------------------------------------------------------
  // GET /v1/unified/models
  // Returns all models from all configured providers in OpenAI list format.
  // --------------------------------------------------------------------------

  const OpenAIModelObjectSchema = z.object({
    id: z.string(),
    object: z.literal("model"),
    created: z.number(),
    owned_by: z.string(),
  });

  const OpenAIModelsListSchema = z.object({
    object: z.literal("list"),
    data: z.array(OpenAIModelObjectSchema),
  });

  fastify.get(
    `${API_PREFIX}${MODELS_SUFFIX}`,
    {
      schema: {
        operationId: RouteId.UnifiedListModels,
        description:
          "List all models available across all configured providers in OpenAI format.",
        tags: ["LLM Proxy"],
        response: constructResponseSchema(OpenAIModelsListSchema),
      },
    },
    async (_request, reply) => {
      logger.debug("[UnifiedProxy] Listing models across all providers");

      // Collect models from the provider API key ↔ model link table
      const allModels =
        await LlmProviderApiKeyModelLinkModel.getAllModelsWithApiKeys();

      // De-duplicate by modelId (a model may appear for multiple API keys)
      const seen = new Set<string>();
      const data = allModels
        .filter(({ model }) => {
          if (seen.has(model.modelId)) return false;
          seen.add(model.modelId);
          return true;
        })
        .map(({ model }) => ({
          id: model.modelId,
          object: "model" as const,
          created: Math.floor(
            (model.createdAt
              ? new Date(model.createdAt).getTime()
              : Date.now()) / 1000,
          ),
          owned_by: model.provider,
        }));

      logger.info(
        { modelCount: data.length },
        "[UnifiedProxy] Returning unified models list",
      );

      return reply.send({ object: "list" as const, data });
    },
  );

  // --------------------------------------------------------------------------
  // POST /v1/unified/chat/completions (default agent)
  // Auto-routes to the right provider based on `model` in the request body.
  // --------------------------------------------------------------------------

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.UnifiedChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion routed to the appropriate provider based on the model name (default agent). Always returns an OpenAI-format response.",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const modelId = request.body.model;
      logger.debug(
        { model: modelId, url: request.url },
        "[UnifiedProxy] Handling unified chat completion (default agent)",
      );
      const adapterFactory = await resolveAdapter(modelId);
      return handleLLMProxy(request.body, request, reply, adapterFactory);
    },
  );

  // --------------------------------------------------------------------------
  // POST /v1/unified/:agentId/chat/completions (specific agent)
  // --------------------------------------------------------------------------

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.UnifiedChatCompletionsWithAgent,
        description:
          "Create a chat completion routed to the appropriate provider based on the model name (specific agent). Always returns an OpenAI-format response.",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const modelId = request.body.model;
      logger.debug(
        {
          model: modelId,
          agentId: request.params.agentId,
          url: request.url,
        },
        "[UnifiedProxy] Handling unified chat completion (with agent)",
      );
      const adapterFactory = await resolveAdapter(modelId);
      return handleLLMProxy(request.body, request, reply, adapterFactory);
    },
  );
};

export default unifiedProxyRoutes;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Resolve the correct OpenAI-compatible adapter factory for a given model ID.
 *
 * Strategy:
 * 1. Query the DB (linked API keys → model → provider)
 * 2. Fall back to the models table (LLM-proxy-discovered models)
 * 3. Apply heuristic prefix matching as a last resort
 * 4. Default to OpenAI adapter
 */
async function resolveAdapter(modelId: string): Promise<OpenAiAdapterFactory> {
  const provider = await resolveProviderForModel(modelId);

  if (provider) {
    const adapter = OPENAI_COMPATIBLE_ADAPTERS[provider];
    if (adapter) {
      logger.info(
        { modelId, provider },
        "[UnifiedProxy] Resolved provider from DB",
      );
      return adapter;
    }

    // Provider found in DB but not OpenAI-wire-format compatible via unified endpoint
    logger.info(
      { modelId, provider },
      "[UnifiedProxy] Provider not OpenAI-wire-format compatible via unified endpoint, using heuristic",
    );
  }

  // Heuristic prefix matching for models not yet in the database
  const heuristicProvider = inferProviderFromModelId(modelId);
  if (heuristicProvider) {
    const adapter = OPENAI_COMPATIBLE_ADAPTERS[heuristicProvider];
    if (adapter) {
      logger.info(
        { modelId, heuristicProvider },
        "[UnifiedProxy] Resolved provider via heuristic",
      );
      return adapter;
    }
  }

  logger.info(
    { modelId },
    "[UnifiedProxy] Could not resolve provider, defaulting to OpenAI adapter",
  );
  return openaiAdapterFactory;
}

/**
 * Look up which provider owns a given model ID by querying the database.
 * Returns null if the model is not found.
 */
async function resolveProviderForModel(
  modelId: string,
): Promise<string | null> {
  // 1. Check models linked to provider API keys (preferred source)
  const allModels =
    await LlmProviderApiKeyModelLinkModel.getAllModelsWithApiKeys();
  const linked = allModels.find(({ model }) => model.modelId === modelId);
  if (linked) {
    return linked.model.provider;
  }

  // 2. Fall back to the models table (LLM-proxy-discovered models)
  const dbModels = await ModelModel.findAll({ search: modelId });
  const exact = dbModels.find((m) => m.modelId === modelId);
  if (exact) {
    return exact.provider;
  }

  return null;
}

/**
 * Infer provider from model ID using well-known prefixes / substrings.
 * This is a best-effort heuristic for models not yet in the database.
 */
function inferProviderFromModelId(modelId: string): string | null {
  const lower = modelId.toLowerCase();

  // OpenAI
  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.startsWith("text-embedding-") ||
    lower.startsWith("davinci") ||
    lower.startsWith("babbage")
  )
    return "openai";

  // Mistral
  if (
    lower.startsWith("mistral-") ||
    lower.startsWith("ministral-") ||
    lower.startsWith("codestral-")
  )
    return "mistral";

  // xAI
  if (lower.startsWith("grok-")) return "xai";

  // DeepSeek
  if (lower.startsWith("deepseek-")) return "deepseek";

  // Perplexity
  if (lower.startsWith("sonar") || lower.includes("perplexity"))
    return "perplexity";

  // MiniMax
  if (lower.startsWith("minimax")) return "minimax";

  // Zhipu AI
  if (lower.startsWith("glm-")) return "zhipuai";

  // Cerebras
  if (lower.includes("cerebras")) return "cerebras";

  // OpenRouter — model IDs contain a slash, e.g. "openai/gpt-4o"
  if (
    lower.startsWith("openrouter/") ||
    (lower.includes("/") &&
      !lower.startsWith("amazon.") &&
      !lower.startsWith("meta.") &&
      !lower.startsWith("models/"))
  )
    return "openrouter";

  return null;
}
