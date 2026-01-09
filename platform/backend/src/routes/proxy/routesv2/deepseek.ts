import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { DeepSeek, UuidIdSchema, constructResponseSchema } from "@/types";
import { deepseekAdapterFactory } from "../adapterV2/deepseek";
import { PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const deepseekProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
    const CHAT_COMPLETIONS_SUFFIX = "/v1/chat/completions";

    fastify.post(
        `/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.DeepSeekChatCompletionsWithAgent,
                description: "Create a chat completion with DeepSeek for a specific agent",
                tags: ["llm-proxy"],
                params: z.object({
                    agentId: UuidIdSchema,
                }),
                body: DeepSeek.API.ChatRequestSchema,
                headers: DeepSeek.API.ChatHeadersSchema,
                response: constructResponseSchema(DeepSeek.API.ChatResponseSchema),
            },
        },
        async (request, reply) => {
            const externalAgentId = utils.externalAgentId.getExternalAgentId(
                request.headers,
            );
            const userId = await utils.userId.getUserId(request.headers);

            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                deepseekAdapterFactory,
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

export default deepseekProxyRoutes;
