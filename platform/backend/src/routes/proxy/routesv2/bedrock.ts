import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { Bedrock, constructResponseSchema, UuidIdSchema } from "@/types";
import { bedrockAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const bedrockProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const BEDROCK_PREFIX = `${PROXY_API_PREFIX}/bedrock`;
  const CONVERSE_SUFFIX = "/converse";
  const CONVERSE_STREAM_SUFFIX = "/converse-stream";

  logger.info("[UnifiedProxy] Registering unified Amazon Bedrock routes");

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
      schema: {
        operationId: RouteId.BedrockConverseWithDefaultAgent,
        description: "Send a message to Amazon Bedrock using the default agent",
        tags: ["llm-proxy"],
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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;
      return handleLLMProxy(
        { ...request.body, _isStreaming: false },
        request.headers,
        reply,
        bedrockAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: undefined,
          externalAgentId,
          executionId,
          userId,
        },
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
      schema: {
        operationId: RouteId.BedrockConverseWithAgent,
        description: "Send a message to Amazon Bedrock for a specific agent",
        tags: ["llm-proxy"],
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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;
      return handleLLMProxy(
        { ...request.body, _isStreaming: false },
        request.headers,
        reply,
        bedrockAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: request.params.agentId,
          externalAgentId,
          executionId,
          userId,
        },
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
      schema: {
        operationId: RouteId.BedrockConverseStreamWithDefaultAgent,
        description:
          "Stream a message response from Amazon Bedrock using the default agent",
        tags: ["llm-proxy"],
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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;

      return handleLLMProxy(
        { ...request.body, _isStreaming: true },
        request.headers,
        reply,
        bedrockAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: undefined,
          externalAgentId,
          executionId,
          userId,
        },
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
      schema: {
        operationId: RouteId.BedrockConverseStreamWithAgent,
        description:
          "Stream a message response from Amazon Bedrock for a specific agent",
        tags: ["llm-proxy"],
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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;

      return handleLLMProxy(
        { ...request.body, _isStreaming: true },
        request.headers,
        reply,
        bedrockAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: request.params.agentId,
          externalAgentId,
          executionId,
          userId,
        },
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
      schema: {
        operationId: RouteId.BedrockConverseWithAgentAndModel,
        description:
          "Send a message to Amazon Bedrock for a specific agent (AI SDK format)",
        tags: ["llm-proxy"],
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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;

      // Inject modelId from URL into request body if not present
      const bodyWithModel = {
        ...request.body,
        modelId:
          request.body.modelId || decodeURIComponent(request.params.modelId),
        _isStreaming: false,
      };

      return handleLLMProxy(
        bodyWithModel,
        request.headers,
        reply,
        bedrockAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: request.params.agentId,
          externalAgentId,
          executionId,
          userId,
        },
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
      schema: {
        operationId: RouteId.BedrockConverseStreamWithAgentAndModel,
        description:
          "Stream a message response from Amazon Bedrock for a specific agent (AI SDK format)",
        tags: ["llm-proxy"],
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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;

      // Inject modelId from URL into request body
      const bodyWithModel = {
        ...request.body,
        modelId:
          request.body.modelId || decodeURIComponent(request.params.modelId),
        _isStreaming: true,
      };

      return handleLLMProxy(
        bodyWithModel,
        request.headers,
        reply,
        bedrockAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: request.params.agentId,
          externalAgentId,
          executionId,
          userId,
        },
      );
    },
  );
};

export default bedrockProxyRoutesV2;
