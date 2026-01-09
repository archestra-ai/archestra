import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { MiniMax, UuidIdSchema, constructResponseSchema } from "@/types";
import { minimaxAdapterFactory } from "../adapterV2/minimax";
import { PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const minimaxProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
    const CHAT_COMPLETIONS_SUFFIX = "/v1/chat/completions";

    fastify.post(
        `/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.OpenAiChatCompletionsWithAgent, // Reusing for now or could create new
                description: "Create a chat completion with MiniMax for a specific agent",
                tags: ["llm-proxy"],
                params: z.object({
                    agentId: UuidIdSchema,
                }),
                body: MiniMax.API.ChatRequestSchema,
                headers: MiniMax.API.ChatHeadersSchema,
                response: constructResponseSchema(MiniMax.API.ChatResponseSchema),
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
                minimaxAdapterFactory,
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

export default minimaxProxyRoutes;
