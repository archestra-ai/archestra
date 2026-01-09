/**
 * x.ai (Grok) Proxy Routes V2
 *
 * Implements OpenAI-compatible routes for x.ai's Grok models.
 * x.ai API endpoint: https://api.x.ai/v1
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, OpenAi, UuidIdSchema } from "@/types";
import { xaiAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const xaiProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
    const API_PREFIX = `${PROXY_API_PREFIX}/xai`;
    const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

    logger.info("[UnifiedProxy] Registering unified x.ai routes");

    await fastify.register(fastifyHttpProxy, {
        upstream: config.llm.xai.baseUrl,
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
                    "x.ai proxy preHandler: skipping chat/completions route",
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
                        upstream: config.llm.xai.baseUrl,
                        finalProxyUrl: `${config.llm.xai.baseUrl}${remainingPath}`,
                    },
                    "x.ai proxy preHandler: URL rewritten (UUID stripped)",
                );
            } else {
                logger.info(
                    {
                        method: request.method,
                        url: request.url,
                        upstream: config.llm.xai.baseUrl,
                        finalProxyUrl: `${config.llm.xai.baseUrl}${pathAfterPrefix}`,
                    },
                    "x.ai proxy preHandler: proxying request",
                );
            }

            next();
        },
    });

    // Chat completions with default agent
    fastify.post(
        `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.XaiChatCompletionsWithDefaultAgent,
                description:
                    "Create a chat completion with x.ai (uses default agent)",
                tags: ["llm-proxy"],
                body: OpenAi.API.ChatCompletionRequestSchema,
                headers: OpenAi.API.ChatCompletionsHeadersSchema,
                response: constructResponseSchema(
                    OpenAi.API.ChatCompletionResponseSchema,
                ),
            },
        },
        async (request, reply) => {
            logger.debug(
                { url: request.url },
                "[UnifiedProxy] Handling x.ai request (default agent)",
            );
            const externalAgentId = utils.externalAgentId.getExternalAgentId(
                request.headers,
            );
            const userId = await utils.userId.getUserId(request.headers);

            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                xaiAdapterFactory,
                {
                    organizationId: request.organizationId,
                    agentId: undefined,
                    externalAgentId,
                    userId,
                },
            );
        },
    );

    // Chat completions with specific agent
    fastify.post(
        `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.XaiChatCompletionsWithAgent,
                description:
                    "Create a chat completion with x.ai (uses specified agent)",
                tags: ["llm-proxy"],
                params: z.object({
                    agentId: UuidIdSchema.describe("The agent ID to use"),
                }),
                body: OpenAi.API.ChatCompletionRequestSchema,
                headers: OpenAi.API.ChatCompletionsHeadersSchema,
                response: constructResponseSchema(
                    OpenAi.API.ChatCompletionResponseSchema,
                ),
            },
        },
        async (request, reply) => {
            const { agentId } = request.params;

            logger.debug(
                { url: request.url, agentId },
                "[UnifiedProxy] Handling x.ai request (specific agent)",
            );

            const externalAgentId = utils.externalAgentId.getExternalAgentId(
                request.headers,
            );
            const userId = await utils.userId.getUserId(request.headers);

            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                xaiAdapterFactory,
                {
                    organizationId: request.organizationId,
                    agentId,
                    externalAgentId,
                    userId,
                },
            );
        },
    );
};

export default xaiProxyRoutesV2;
