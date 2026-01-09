import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { Cohere, constructResponseSchema, UuidIdSchema } from "@/types";
import { cohereAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const cohereProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
    const COHERE_PREFIX = `${PROXY_API_PREFIX}/cohere`;
    const CHAT_SUFFIX = "/chat";

    logger.info("[UnifiedProxy] Registering unified Cohere routes");

    /**
     * Cohere SDK standard format
     * No agentId is provided -- agent is created/fetched based on the user-agent header
     */
    fastify.post(
        `${COHERE_PREFIX}${CHAT_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.CohereChatWithDefaultAgent,
                description: "Send a message to Cohere using the default agent",
                tags: ["llm-proxy"],
                body: Cohere.API.ChatRequestSchema,
                headers: Cohere.API.ChatHeadersSchema,
                response: constructResponseSchema(Cohere.API.ChatResponseSchema),
            },
        },
        async (request, reply) => {
            logger.debug(
                { url: request.url },
                "[UnifiedProxy] Handling Cohere request (default agent)",
            );
            const externalAgentId = utils.externalAgentId.getExternalAgentId(
                request.headers,
            );
            const userId = await utils.userId.getUserId(request.headers);
            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                cohereAdapterFactory,
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
     * Cohere SDK standard format
     * An agentId is provided -- agent is fetched based on the agentId
     */
    fastify.post(
        `${COHERE_PREFIX}/:agentId${CHAT_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.CohereChatWithAgent,
                description:
                    "Send a message to Cohere using a specific agent",
                tags: ["llm-proxy"],
                params: z.object({
                    agentId: UuidIdSchema,
                }),
                body: Cohere.API.ChatRequestSchema,
                headers: Cohere.API.ChatHeadersSchema,
                response: constructResponseSchema(Cohere.API.ChatResponseSchema),
            },
        },
        async (request, reply) => {
            logger.debug(
                { url: request.url, agentId: request.params.agentId },
                "[UnifiedProxy] Handling Cohere request (with agent)",
            );
            const externalAgentId = utils.externalAgentId.getExternalAgentId(
                request.headers,
            );
            const userId = await utils.userId.getUserId(request.headers);
            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                cohereAdapterFactory,
                {
                    organizationId: request.organizationId,
                    agentId: request.params.agentId,
                    externalAgentId,
                    userId,
                },
            );
        },
    );
};

export default cohereProxyRoutesV2;
