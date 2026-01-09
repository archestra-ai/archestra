import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { Mistral, UuidIdSchema, constructResponseSchema } from "@/types";
import { mistralAdapterFactory } from "../adapterV2/mistral";
import { PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const mistralProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
    const CHAT_COMPLETIONS_SUFFIX = "/v1/chat/completions";

    fastify.post(
        `/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.MistralChatCompletionsWithAgent,
                description: "Create a chat completion with Mistral for a specific agent",
                tags: ["llm-proxy"],
                params: z.object({
                    agentId: UuidIdSchema,
                }),
                body: Mistral.API.ChatRequestSchema,
                headers: Mistral.API.ChatHeadersSchema,
                response: constructResponseSchema(Mistral.API.ChatResponseSchema),
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
                mistralAdapterFactory,
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

export default mistralProxyRoutes;
