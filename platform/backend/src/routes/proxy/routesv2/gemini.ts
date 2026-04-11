import fastifyHttpProxy from "@fastify/http-proxy";
import { hasArchestraTokenPrefix } from "@shared";
import type { FastifyReply, FastifyRequest } from "fastify";
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
import { validateVirtualApiKey } from "../llm-proxy-auth";
import { handleLLMProxy } from "../llm-proxy-handler";

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
    preHandler: createGeminiProxyPreHandler(),
  });

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.gemini.baseUrl,
    prefix: `${API_PREFIX}/:agentId/v1beta`,
    rewritePrefix: "/v1",
    preHandler: createGeminiProxyPreHandler(),
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
        tags: ["LLM Proxy"],
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
      // Inject model and streaming flag into body for adapter
      const requestWithModel: GeminiRequestWithModel = {
        ...request.body,
        _model: request.params.model,
        _isStreaming: false,
      };

      return handleLLMProxy(
        requestWithModel,
        request,
        reply,
        geminiAdapterFactory,
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
        tags: ["LLM Proxy"],
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
      // Inject model and streaming flag into body for adapter
      const requestWithModel: GeminiRequestWithModel = {
        ...request.body,
        _model: request.params.model,
        _isStreaming: true,
      };

      return handleLLMProxy(
        requestWithModel,
        request,
        reply,
        geminiAdapterFactory,
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
        tags: ["LLM Proxy"],
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

      // Inject model and streaming flag into body for adapter
      const requestWithModel: GeminiRequestWithModel = {
        ...request.body,
        _model: request.params.model,
        _isStreaming: false,
      };

      return handleLLMProxy(
        requestWithModel,
        request,
        reply,
        geminiAdapterFactory,
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
        tags: ["LLM Proxy"],
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

      // Inject model and streaming flag into body for adapter
      const requestWithModel: GeminiRequestWithModel = {
        ...request.body,
        _model: request.params.model,
        _isStreaming: true,
      };

      return handleLLMProxy(
        requestWithModel,
        request,
        reply,
        geminiAdapterFactory,
      );
    },
  );
};

export default geminiProxyRoutesV2;

function createGeminiProxyPreHandler() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const urlPath = request.url.split("?")[0];
    if (
      request.method === "POST" &&
      (urlPath.includes(":generateContent") ||
        urlPath.includes(":streamGenerateContent"))
    ) {
      reply.code(400).send({
        error: {
          code: 400,
          message: "generateContent requests should use the dedicated endpoint",
          status: "INVALID_ARGUMENT",
        },
      });
      return;
    }

    await resolveGeminiVirtualQueryKey(request);
  };
}

/**
 * Resolves virtual API keys in Gemini's ?key= query parameter.
 * Gemini uses ?key= for auth (unlike OpenAI which uses Authorization header).
 * If the key is a platform virtual key, resolve it
 * to the real provider API key and rewrite the URL. Real Gemini keys pass through unchanged.
 */
async function resolveGeminiVirtualQueryKey(request: FastifyRequest) {
  const url = request.raw.url;
  if (!url) return;

  const keyMatch = url.match(/[?&]key=([^&]+)/);
  if (!keyMatch) return;

  const keyValue = keyMatch[1];
  if (!hasArchestraTokenPrefix(keyValue)) return;

  try {
    const resolved = await validateVirtualApiKey(keyValue, "gemini");
    if (!resolved.apiKey) return;

    request.raw.url = url.replace(`key=${keyValue}`, `key=${resolved.apiKey}`);

    logger.info(
      { method: request.method, url: request.url },
      "Gemini proxy: resolved virtual API key in query parameter",
    );
  } catch (error) {
    logger.warn(
      { error, method: request.method, url: request.url },
      "Gemini proxy: failed to resolve virtual API key",
    );
    throw error;
  }
}
