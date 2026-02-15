import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import {
  constructResponseSchema,
  ErrorResponsesSchema,
  Gemini,
  UuidIdSchema,
} from "@/types";
import {
  type GeminiRequestWithModel,
  geminiAdapterFactory,
} from "../adapterV2/gemini";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

/**
 * NOTE: Gemini uses colon-literals in their routes. For fastify, double colon is used to escape the colon-literal in
 * the route
 */
const geminiProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/gemini`;

  logger.info("[UnifiedProxy] Registering unified Gemini V2 routes");

  /**
   * Register HTTP proxy for all Gemini routes EXCEPT generateContent and streamGenerateContent
   * This will proxy routes like /v1/gemini/models to https://generativelanguage.googleapis.com/v1beta/models
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.gemini.baseUrl,
    prefix: `${API_PREFIX}/v1beta`,
    rewritePrefix: "/v1",
    /**
     * Exclude generateContent and streamGenerateContent routes since we handle them below
     */
    preHandler: (request, _reply, next) => {
      if (
        request.method === "POST" &&
        (request.url.includes(":generateContent") ||
          request.url.includes(":streamGenerateContent"))
      ) {
        // Skip proxy for these routes - we handle them below
        next(new Error("skip"));
      } else {
        next();
      }
    },
  });

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.gemini.baseUrl,
    prefix: `${API_PREFIX}/:agentId/v1beta`,
    rewritePrefix: "/v1",
    /**
     * Exclude generateContent and streamGenerateContent routes since we handle them below
     */
    preHandler: (request, _reply, next) => {
      if (
        request.method === "POST" &&
        (request.url.includes(":generateContent") ||
          request.url.includes(":streamGenerateContent"))
      ) {
        // Skip proxy for these routes - we handle them below
        next(new Error("skip"));
      } else {
        next();
      }
    },
  });

  /**
   * Generate route endpoint pattern for Gemini
   * Uses regex param syntax to handle the colon-literal properly
   */
  const generateRouteEndpoint = (
    verb: "generateContent" | "streamGenerateContent",
    includeAgentId = false,
  ) =>
    `${API_PREFIX}/${includeAgentId ? ":agentId/" : ""}v1beta/models/:model(^[a-zA-Z0-9-.]+$)::${verb}`;

  /**
   * Default agent endpoint for Gemini generateContent (non-streaming)
   */
  fastify.post(
    generateRouteEndpoint("generateContent"),
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description: "Generate content using Gemini (default agent)",
        summary: "Generate content using Gemini",
        tags: ["llm-proxy"],
        params: z.object({
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        response: constructResponseSchema(
          Gemini.API.GenerateContentResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, model: request.params.model },
        "[UnifiedProxy] Handling Gemini request (default agent, non-streaming)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;

      // Inject model and streaming flag into body for adapter
      const requestWithModel: GeminiRequestWithModel = {
        ...request.body,
        _model: request.params.model,
        _isStreaming: false,
      };

      return handleLLMProxy(
        requestWithModel,
        request.headers,
        reply,
        geminiAdapterFactory,
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
   * Default agent endpoint for Gemini streamGenerateContent (streaming)
   */
  fastify.post(
    generateRouteEndpoint("streamGenerateContent"),
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description: "Stream generated content using Gemini (default agent)",
        summary: "Stream generated content using Gemini",
        tags: ["llm-proxy"],
        params: z.object({
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        // Streaming responses don't have a schema
        response: ErrorResponsesSchema,
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, model: request.params.model },
        "[UnifiedProxy] Handling Gemini request (default agent, streaming)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;

      // Inject model and streaming flag into body for adapter
      const requestWithModel: GeminiRequestWithModel = {
        ...request.body,
        _model: request.params.model,
        _isStreaming: true,
      };

      return handleLLMProxy(
        requestWithModel,
        request.headers,
        reply,
        geminiAdapterFactory,
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
   * Agent-specific endpoint for Gemini generateContent (non-streaming)
   */
  fastify.post(
    generateRouteEndpoint("generateContent", true),
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description: "Generate content using Gemini with specific agent",
        summary: "Generate content using Gemini (specific agent)",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        response: constructResponseSchema(
          Gemini.API.GenerateContentResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        {
          url: request.url,
          agentId: request.params.agentId,
          model: request.params.model,
        },
        "[UnifiedProxy] Handling Gemini request (with agent, non-streaming)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;

      // Inject model and streaming flag into body for adapter
      const requestWithModel: GeminiRequestWithModel = {
        ...request.body,
        _model: request.params.model,
        _isStreaming: false,
      };

      return handleLLMProxy(
        requestWithModel,
        request.headers,
        reply,
        geminiAdapterFactory,
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
   * Agent-specific endpoint for Gemini streamGenerateContent (streaming)
   */
  fastify.post(
    generateRouteEndpoint("streamGenerateContent", true),
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description:
          "Stream generated content using Gemini with specific agent",
        summary: "Stream generated content using Gemini (specific agent)",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        // Streaming responses don't have a schema
        response: ErrorResponsesSchema,
      },
    },
    async (request, reply) => {
      logger.debug(
        {
          url: request.url,
          agentId: request.params.agentId,
          model: request.params.model,
        },
        "[UnifiedProxy] Handling Gemini request (with agent, streaming)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;

      // Inject model and streaming flag into body for adapter
      const requestWithModel: GeminiRequestWithModel = {
        ...request.body,
        _model: request.params.model,
        _isStreaming: true,
      };

      return handleLLMProxy(
        requestWithModel,
        request.headers,
        reply,
        geminiAdapterFactory,
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

export default geminiProxyRoutesV2;
