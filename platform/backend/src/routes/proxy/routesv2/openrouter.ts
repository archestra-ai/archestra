/**
 * OpenRouter Proxy Routes (V2 - Unified Handler)
 *
 * Routes for OpenRouter LLM proxy using the unified handler architecture.
 * OpenRouter uses OpenAI-compatible API format.
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, OpenRouter, UuidIdSchema } from "@/types";
import { openrouterAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const openRouterProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
    const API_PREFIX = `${PROXY_API_PREFIX}/openrouter`;
    const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

    logger.info("[UnifiedProxy] Registering unified OpenRouter routes");

    // HTTP proxy for non-chat-completion requests (e.g., models list)
    await fastify.register(fastifyHttpProxy, {
        upstream: config.llm.openrouter.baseUrl,
        prefix: API_PREFIX,
        rewritePrefix: "",
        preHandler: (request, _reply, next) => {
            if (
                request.method === "POST" &&
                request.url.includes(CHAT_COMPLETIONS_SUFFIX)
            ) {
                logger.info(
                    {
                        method: request.method,
                        url: request.url,
                        action: "skip-proxy",
                        reason: "handled-by-custom-handler",
                    },
                    "OpenRouter proxy preHandler: skipping chat/completions route",
                );
                next(new Error("skip"));
                return;
            }

            const pathAfterPrefix = request.url.replace(API_PREFIX, "");
            const uuidMatch = pathAfterPrefix.match(
                /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
            );

            if (uuidMatch) {
                const remainingPath = uuidMatch[2] || "";
                const originalUrl = request.raw.url;
                request.raw.url = `${API_PREFIX}${remainingPath}`;

                logger.info(
                    {
                        method: request.method,
                        originalUrl,
                        rewrittenUrl: request.raw.url,
                        upstream: config.llm.openrouter.baseUrl,
                        finalProxyUrl: `${config.llm.openrouter.baseUrl}${remainingPath}`,
                    },
                    "OpenRouter proxy preHandler: URL rewritten (UUID stripped)",
                );
            } else {
                logger.info(
                    {
                        method: request.method,
                        url: request.url,
                        upstream: config.llm.openrouter.baseUrl,
                        finalProxyUrl: `${config.llm.openrouter.baseUrl}${pathAfterPrefix}`,
                    },
                    "OpenRouter proxy preHandler: proxying request",
                );
            }

            next();
        },
    });

    // Chat completions without agent ID (uses default agent)
    fastify.post(
        `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.OpenRouterChatCompletionsWithDefaultAgent,
                description:
                    "Create a chat completion with OpenRouter (uses default agent)",
                tags: ["llm-proxy"],
                body: OpenRouter.API.ChatCompletionRequestSchema,
                headers: OpenRouter.API.ChatCompletionsHeadersSchema,
                response: constructResponseSchema(
                    OpenRouter.API.ChatCompletionResponseSchema,
                ),
            },
        },
        async (request, reply) => {
            logger.debug(
                { url: request.url },
                "[UnifiedProxy] Handling OpenRouter request (default agent)",
            );
            const externalAgentId = utils.externalAgentId.getExternalAgentId(
                request.headers,
            );
            const userId = await utils.userId.getUserId(request.headers);
            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                openrouterAdapterFactory,
                {
                    organizationId: request.organizationId,
                    agentId: undefined,
                    externalAgentId,
                    userId,
                },
            );
        },
    );

    // Chat completions with specific agent ID
    fastify.post(
        `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.OpenRouterChatCompletionsWithAgent,
                description:
                    "Create a chat completion with OpenRouter for a specific agent",
                tags: ["llm-proxy"],
                params: z.object({
                    agentId: UuidIdSchema,
                }),
                body: OpenRouter.API.ChatCompletionRequestSchema,
                headers: OpenRouter.API.ChatCompletionsHeadersSchema,
                response: constructResponseSchema(
                    OpenRouter.API.ChatCompletionResponseSchema,
                ),
            },
        },
        async (request, reply) => {
            logger.debug(
                { url: request.url, agentId: request.params.agentId },
                "[UnifiedProxy] Handling OpenRouter request (with agent)",
            );
            const externalAgentId = utils.externalAgentId.getExternalAgentId(
                request.headers,
            );
            const userId = await utils.userId.getUserId(request.headers);
            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                openrouterAdapterFactory,
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

export default openRouterProxyRoutesV2;
