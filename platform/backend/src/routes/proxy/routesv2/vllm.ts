/**
 * vLLM Proxy Routes V2
 *
 * Implements OpenAI-compatible routes for vLLM.
 * vLLM API endpoint configurable via ARCHESTRA_VLLM_BASE_URL (default: http://localhost:8000/v1)
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, OpenAi, UuidIdSchema } from "@/types";
import { vllmAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const vllmProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
    const API_PREFIX = `${PROXY_API_PREFIX}/vllm`;
    const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

    logger.info("[UnifiedProxy] Registering unified vLLM routes");

    await fastify.register(fastifyHttpProxy, {
        upstream: config.llm.vllm.baseUrl,
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
                    "vLLM proxy preHandler: skipping chat/completions route",
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
                        upstream: config.llm.vllm.baseUrl,
                        finalProxyUrl: `${config.llm.vllm.baseUrl}${remainingPath}`,
                    },
                    "vLLM proxy preHandler: URL rewritten (UUID stripped)",
                );
            } else {
                logger.info(
                    {
                        method: request.method,
                        url: request.url,
                        upstream: config.llm.vllm.baseUrl,
                        finalProxyUrl: `${config.llm.vllm.baseUrl}${pathAfterPrefix}`,
                    },
                    "vLLM proxy preHandler: proxying request",
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
                operationId: RouteId.VllmChatCompletionsWithDefaultAgent,
                description:
                    "Create a chat completion with vLLM (uses default agent)",
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
                "[UnifiedProxy] Handling vLLM request (default agent)",
            );
            const externalAgentId = utils.externalAgentId.getExternalAgentId(
                request.headers,
            );

            const proxyConfig = {
                upstream: config.llm.vllm.baseUrl,
                endpoint: CHAT_COMPLETIONS_SUFFIX,
                provider: "vllm" as const,
            };

            return handleLLMProxy({
                request,
                reply,
                proxyConfig,
                adapterFactory: vllmAdapterFactory,
                externalAgentId,
            });
        },
    );

    // Chat completions with specific agent
    fastify.post(
        `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.VllmChatCompletionsWithAgent,
                description:
                    "Create a chat completion with vLLM (uses specified agent)",
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
                "[UnifiedProxy] Handling vLLM request (specific agent)",
            );

            const proxyConfig = {
                upstream: config.llm.vllm.baseUrl,
                endpoint: CHAT_COMPLETIONS_SUFFIX,
                provider: "vllm" as const,
            };

            return handleLLMProxy({
                request,
                reply,
                proxyConfig,
                adapterFactory: vllmAdapterFactory,
                agentId,
            });
        },
    );
};

export default vllmProxyRoutesV2;
