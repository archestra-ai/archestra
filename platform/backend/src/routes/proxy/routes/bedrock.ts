import { RouteId } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { Bedrock, constructResponseSchema, UuidIdSchema } from "@/types";
import { asRecord } from "@/utils/as-record";
import {
  bedrockAdapterFactory,
  bedrockInvokeAdapterFactory,
} from "../adapters";
import { canTranslateConverseRequest } from "../adapters/openai-bedrock-translator";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

// Zod strips unknown keys on known Converse shapes. Detect native-only
// behavior before that validation, without changing the native request schema.
const nativeOnlyConverseRequests = new WeakSet<FastifyRequest>();
async function detectNativeConverse(request: FastifyRequest) {
  const modelParam = asRecord(request.params)?.modelId;
  let urlModel = typeof modelParam === "string" ? modelParam : undefined;
  if (urlModel) {
    try {
      urlModel = decodeURIComponent(urlModel);
    } catch {
      // Leave invalid URI handling to the existing route.
    }
  }
  if (!canTranslateConverseRequest(request.body, urlModel))
    nativeOnlyConverseRequests.add(request);
}

const bedrockProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const BEDROCK_PREFIX = `${PROXY_API_PREFIX}/bedrock`;
  const CONVERSE_SUFFIX = "/converse";
  const CONVERSE_STREAM_SUFFIX = "/converse-stream";
  const INVOKE_SUFFIX = "/invoke";
  const INVOKE_STREAM_SUFFIX = "/invoke-with-response-stream";

  logger.debug("[UnifiedProxy] Registering unified Amazon Bedrock routes");

  /**
   * Bedrock Converse API (default agent)
   * POST /v1/bedrock/converse
   *
   * Uses the Bedrock Converse API format which provides a unified interface
   * for multiple foundation models.
   */
  fastify.post(
    `${BEDROCK_PREFIX}${CONVERSE_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      preValidation: detectNativeConverse,
      schema: {
        operationId: RouteId.BedrockConverseWithDefaultAgent,
        description: "Send a message to Amazon Bedrock using the default agent",
        tags: ["LLM Proxy"],
        body: Bedrock.API.ConverseRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        response: constructResponseSchema(Bedrock.API.ConverseResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Bedrock Converse request (default agent)",
      );
      return handleLLMProxy(
        { ...request.body, _isStreaming: false },
        request,
        reply,
        bedrockAdapterFactory,
        { preserveNativeConverse: nativeOnlyConverseRequests.has(request) },
      );
    },
  );

  /**
   * Bedrock Converse API (with agent)
   * POST /v1/bedrock/:agentId/converse
   *
   * Uses the Bedrock Converse API format with a specific agent ID.
   */
  fastify.post(
    `${BEDROCK_PREFIX}/:agentId${CONVERSE_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      preValidation: detectNativeConverse,
      schema: {
        operationId: RouteId.BedrockConverseWithAgent,
        description: "Send a message to Amazon Bedrock for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Bedrock.API.ConverseRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        response: constructResponseSchema(Bedrock.API.ConverseResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Bedrock Converse request (with agent)",
      );
      return handleLLMProxy(
        { ...request.body, _isStreaming: false },
        request,
        reply,
        bedrockAdapterFactory,
        { preserveNativeConverse: nativeOnlyConverseRequests.has(request) },
      );
    },
  );

  /**
   * Bedrock ConverseStream API (default agent)
   * POST /v1/bedrock/converse-stream
   *
   * Streaming version of the Converse API.
   */
  fastify.post(
    `${BEDROCK_PREFIX}${CONVERSE_STREAM_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      preValidation: detectNativeConverse,
      schema: {
        operationId: RouteId.BedrockConverseStreamWithDefaultAgent,
        description:
          "Stream a message response from Amazon Bedrock using the default agent",
        tags: ["LLM Proxy"],
        body: Bedrock.API.ConverseRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        // Streaming responses don't have a schema
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Bedrock ConverseStream request (default agent)",
      );
      return handleLLMProxy(
        { ...request.body, _isStreaming: true },
        request,
        reply,
        bedrockAdapterFactory,
        { preserveNativeConverse: nativeOnlyConverseRequests.has(request) },
      );
    },
  );

  /**
   * Bedrock ConverseStream API (with agent)
   * POST /v1/bedrock/:agentId/converse-stream
   *
   * Streaming version of the Converse API with a specific agent ID.
   */
  fastify.post(
    `${BEDROCK_PREFIX}/:agentId${CONVERSE_STREAM_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      preValidation: detectNativeConverse,
      schema: {
        operationId: RouteId.BedrockConverseStreamWithAgent,
        description:
          "Stream a message response from Amazon Bedrock for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Bedrock.API.ConverseRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        // Streaming responses don't have a schema
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Bedrock ConverseStream request (with agent)",
      );
      return handleLLMProxy(
        { ...request.body, _isStreaming: true },
        request,
        reply,
        bedrockAdapterFactory,
        { preserveNativeConverse: nativeOnlyConverseRequests.has(request) },
      );
    },
  );

  // =============================================================================
  // AI SDK Compatible Routes
  // The @ai-sdk/amazon-bedrock SDK uses URLs like /model/:modelId/converse
  // These routes handle that pattern and inject the modelId into the request body
  // =============================================================================

  /**
   * Bedrock Converse API (AI SDK format with agent and model in URL)
   * POST /v1/bedrock/:agentId/model/:modelId/converse
   *
   * Used by @ai-sdk/amazon-bedrock which puts the model ID in the URL.
   */
  fastify.post(
    `${BEDROCK_PREFIX}/:agentId/model/:modelId${CONVERSE_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      preValidation: detectNativeConverse,
      schema: {
        operationId: RouteId.BedrockConverseWithAgentAndModel,
        description:
          "Send a message to Amazon Bedrock for a specific agent (AI SDK format)",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          modelId: z.string(),
        }),
        body: Bedrock.API.ConverseRequestWithModelInUrlSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        response: constructResponseSchema(Bedrock.API.ConverseResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        {
          url: request.url,
          agentId: request.params.agentId,
          modelId: request.params.modelId,
        },
        "[UnifiedProxy] Handling Bedrock Converse request (AI SDK format)",
      );

      // Inject modelId from URL into request body if not present
      const bodyWithModel = {
        ...request.body,
        modelId:
          request.body.modelId || decodeURIComponent(request.params.modelId),
        _isStreaming: false,
      };

      return handleLLMProxy(
        bodyWithModel,
        request,
        reply,
        bedrockAdapterFactory,
        { preserveNativeConverse: nativeOnlyConverseRequests.has(request) },
      );
    },
  );

  /**
   * Bedrock ConverseStream API (AI SDK format with agent and model in URL)
   * POST /v1/bedrock/:agentId/model/:modelId/converse-stream
   *
   * Used by @ai-sdk/amazon-bedrock which puts the model ID in the URL.
   */
  fastify.post(
    `${BEDROCK_PREFIX}/:agentId/model/:modelId${CONVERSE_STREAM_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      preValidation: detectNativeConverse,
      schema: {
        operationId: RouteId.BedrockConverseStreamWithAgentAndModel,
        description:
          "Stream a message response from Amazon Bedrock for a specific agent (AI SDK format)",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          modelId: z.string(),
        }),
        body: Bedrock.API.ConverseRequestWithModelInUrlSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        // Streaming responses don't have a schema
      },
    },
    async (request, reply) => {
      logger.debug(
        {
          url: request.url,
          agentId: request.params.agentId,
          modelId: request.params.modelId,
        },
        "[UnifiedProxy] Handling Bedrock ConverseStream request (AI SDK format)",
      );

      // Inject modelId from URL into request body
      const bodyWithModel = {
        ...request.body,
        modelId:
          request.body.modelId || decodeURIComponent(request.params.modelId),
        _isStreaming: true,
      };

      return handleLLMProxy(
        bodyWithModel,
        request,
        reply,
        bedrockAdapterFactory,
        { preserveNativeConverse: nativeOnlyConverseRequests.has(request) },
      );
    },
  );

  // =============================================================================
  // Native InvokeModel Routes (Anthropic Messages wire format)
  // The Anthropic SDK's Bedrock client (and Claude Code with
  // CLAUDE_CODE_USE_BEDROCK=1) calls POST /model/:modelId/invoke and
  // POST /model/:modelId/invoke-with-response-stream with an Anthropic
  // Messages body. These routes inject the model from the URL and run the
  // request through the bedrock-invoke adapter.
  // =============================================================================

  /**
   * Bedrock InvokeModel (default agent)
   * POST /v1/bedrock/model/:modelId/invoke
   */
  fastify.post(
    `${BEDROCK_PREFIX}/model/:modelId${INVOKE_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.BedrockInvokeWithDefaultAgentAndModel,
        description:
          "Invoke an Anthropic model on Amazon Bedrock (Anthropic Messages format, default agent)",
        tags: ["LLM Proxy"],
        params: z.object({
          modelId: z.string(),
        }),
        body: Bedrock.API.InvokeRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        response: constructResponseSchema(Bedrock.API.InvokeResponseWireSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, modelId: request.params.modelId },
        "[UnifiedProxy] Handling Bedrock InvokeModel request (default agent)",
      );
      return handleLLMProxy(
        buildInvokeProxyBody(request.body, request.params.modelId, false),
        request,
        reply,
        bedrockInvokeAdapterFactory,
      );
    },
  );

  /**
   * Bedrock InvokeModel (with agent)
   * POST /v1/bedrock/:agentId/model/:modelId/invoke
   */
  fastify.post(
    `${BEDROCK_PREFIX}/:agentId/model/:modelId${INVOKE_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.BedrockInvokeWithAgentAndModel,
        description:
          "Invoke an Anthropic model on Amazon Bedrock (Anthropic Messages format) for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          modelId: z.string(),
        }),
        body: Bedrock.API.InvokeRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        response: constructResponseSchema(Bedrock.API.InvokeResponseWireSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        {
          url: request.url,
          agentId: request.params.agentId,
          modelId: request.params.modelId,
        },
        "[UnifiedProxy] Handling Bedrock InvokeModel request (with agent)",
      );
      return handleLLMProxy(
        buildInvokeProxyBody(request.body, request.params.modelId, false),
        request,
        reply,
        bedrockInvokeAdapterFactory,
      );
    },
  );

  /**
   * Bedrock InvokeModelWithResponseStream (default agent)
   * POST /v1/bedrock/model/:modelId/invoke-with-response-stream
   */
  fastify.post(
    `${BEDROCK_PREFIX}/model/:modelId${INVOKE_STREAM_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.BedrockInvokeStreamWithDefaultAgentAndModel,
        description:
          "Stream an Anthropic model response from Amazon Bedrock (Anthropic Messages format, default agent)",
        tags: ["LLM Proxy"],
        params: z.object({
          modelId: z.string(),
        }),
        body: Bedrock.API.InvokeRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        // Streaming responses don't have a schema
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, modelId: request.params.modelId },
        "[UnifiedProxy] Handling Bedrock InvokeModelWithResponseStream request (default agent)",
      );
      return handleLLMProxy(
        buildInvokeProxyBody(request.body, request.params.modelId, true),
        request,
        reply,
        bedrockInvokeAdapterFactory,
      );
    },
  );

  /**
   * Bedrock InvokeModelWithResponseStream (with agent)
   * POST /v1/bedrock/:agentId/model/:modelId/invoke-with-response-stream
   */
  fastify.post(
    `${BEDROCK_PREFIX}/:agentId/model/:modelId${INVOKE_STREAM_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.BedrockInvokeStreamWithAgentAndModel,
        description:
          "Stream an Anthropic model response from Amazon Bedrock (Anthropic Messages format) for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          modelId: z.string(),
        }),
        body: Bedrock.API.InvokeRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
        // Streaming responses don't have a schema
      },
    },
    async (request, reply) => {
      logger.debug(
        {
          url: request.url,
          agentId: request.params.agentId,
          modelId: request.params.modelId,
        },
        "[UnifiedProxy] Handling Bedrock InvokeModelWithResponseStream request (with agent)",
      );
      return handleLLMProxy(
        buildInvokeProxyBody(request.body, request.params.modelId, true),
        request,
        reply,
        bedrockInvokeAdapterFactory,
      );
    },
  );
};

/**
 * Inject the model from the URL path (the InvokeModel body has no `model`
 * field) and the internal streaming flag before handing the Anthropic-format
 * body to the proxy pipeline.
 */
function buildInvokeProxyBody(
  body: z.infer<typeof Bedrock.API.InvokeRequestSchema>,
  modelIdParam: string,
  isStreaming: boolean,
) {
  return {
    ...body,
    model: body.model || decodeURIComponent(modelIdParam),
    _isStreaming: isStreaming,
  };
}

export default bedrockProxyRoutes;
