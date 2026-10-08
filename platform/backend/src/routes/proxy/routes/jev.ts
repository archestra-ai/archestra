/**
 * Jev LLM Proxy Routes - decisions only
 *
 * Jev has one endpoint, so there is no catch-all forwarder: the provider key's
 * base URL is the full upstream decisions endpoint, and these routes are the
 * only way to reach it.
 */

import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { constructResponseSchema, Jev, UuidIdSchema } from "@/types";
import { jevAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

const jevProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/jev`;
  const DECISIONS_SUFFIX = "/decisions";

  logger.debug("[UnifiedProxy] Registering unified Jev routes");

  fastify.post(
    `${API_PREFIX}${DECISIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.JevDecisionsWithDefaultAgent,
        description: "Request decisions from Jev (uses default agent)",
        tags: ["LLM Proxy"],
        body: Jev.API.DecisionsRequestSchema,
        headers: Jev.API.DecisionsHeadersSchema,
        response: constructResponseSchema(Jev.API.DecisionsResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Jev request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, jevAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${DECISIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.JevDecisionsWithAgent,
        description: "Request decisions from Jev for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Jev.API.DecisionsRequestSchema,
        headers: Jev.API.DecisionsHeadersSchema,
        response: constructResponseSchema(Jev.API.DecisionsResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Jev request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, jevAdapterFactory);
    },
  );
};

export default jevProxyRoutes;
