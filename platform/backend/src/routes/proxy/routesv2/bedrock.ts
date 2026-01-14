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
      logger.info(
        {
          url: request.url,
          headers: {
            ...request.headers,
            // Mask sensitive credentials in logs
            "x-amz-secret-access-key": request.headers["x-amz-secret-access-key"]
              ? "***"
              : undefined,
            "x-amz-session-token": request.headers["x-amz-session-token"]
              ? "***"
              : undefined,
          },
          bodyKeys: Object.keys(request.body || {}),
        },
        "[UnifiedProxy] Handling Bedrock request (default agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        bedrockAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: undefined,
          externalAgentId,
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
        description:
          "Send a message to Amazon Bedrock using a specific agent",
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
      logger.info(
        {
          url: request.url,
          agentId: request.params.agentId,
          headers: {
            ...request.headers,
            // Mask sensitive credentials in logs
            "x-amz-secret-access-key": request.headers["x-amz-secret-access-key"]
              ? "***"
              : undefined,
            "x-amz-session-token": request.headers["x-amz-session-token"]
              ? "***"
              : undefined,
          },
          bodyKeys: Object.keys(request.body || {}),
        },
        "[UnifiedProxy] Handling Bedrock request (with agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        bedrockAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: request.params.agentId,
          externalAgentId,
          userId,
        },
      );
    },
  );

  /**
   * Bedrock Converse API with model ID in path (default agent)
   * POST /v1/bedrock/model/:modelId/converse
   *
   * Alternative endpoint that allows specifying the model in the path
   * instead of the request body.
   */
  fastify.post(
    `${BEDROCK_PREFIX}/model/:modelId${CONVERSE_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.BedrockConverseWithDefaultAgent + "_model",
        description:
          "Send a message to Amazon Bedrock with model ID in path",
        tags: ["llm-proxy"],
        params: z.object({
          modelId: z.string(),
        }),
        body: Bedrock.API.ConverseRequestSchema.omit({ modelId: true }),
        headers: Bedrock.API.ConverseHeadersSchema,
        response: constructResponseSchema(Bedrock.API.ConverseResponseSchema),
      },
    },
    async (request, reply) => {
      logger.info(
        {
          url: request.url,
          modelId: request.params.modelId,
          headers: {
            ...request.headers,
            "x-amz-secret-access-key": request.headers["x-amz-secret-access-key"]
              ? "***"
              : undefined,
            "x-amz-session-token": request.headers["x-amz-session-token"]
              ? "***"
              : undefined,
          },
          bodyKeys: Object.keys(request.body || {}),
        },
        "[UnifiedProxy] Handling Bedrock request (model in path)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);

      // Merge model ID from path into request body
      const bodyWithModel = {
        ...request.body,
        modelId: request.params.modelId,
      };

      return handleLLMProxy(
        bodyWithModel,
        request.headers,
        reply,
        bedrockAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: undefined,
          externalAgentId,
          userId,
        },
      );
    },
  );
};

export default bedrockProxyRoutesV2;
