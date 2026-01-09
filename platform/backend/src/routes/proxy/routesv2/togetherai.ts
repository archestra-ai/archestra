import { TogetherAI } from "@/types";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { togetheraiAdapterFactory } from "../adapterV2";
import { PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { constructResponseSchema } from "@/types";
import * as utils from "../utils";

const togetheraiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post(
        "/togetherai/v1/chat/completions",
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.TogetherAiChatCompletionsWithDefaultAgent,
                description: "Create a chat completion with Together AI (uses default agent)",
                tags: ["llm-proxy"],
                body: TogetherAI.API.ChatRequestSchema,
                headers: TogetherAI.API.ChatHeadersSchema,
                response: constructResponseSchema(TogetherAI.API.ChatResponseSchema),
            },
        },
        async (request, reply) => {
            const externalAgentId = utils.externalAgentId.getExternalAgentId(request.headers);
            const userId = await utils.userId.getUserId(request.headers);
            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                togetheraiAdapterFactory,
                {
                    organizationId: request.organizationId,
                    agentId: undefined,
                    externalAgentId,
                    userId,
                },
            );
        },
    );
};

export default togetheraiProxyRoutes;
