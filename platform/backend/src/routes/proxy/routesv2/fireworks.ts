import { Fireworks } from "@/types";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { fireworksAdapterFactory } from "../adapterV2";
import { PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { constructResponseSchema } from "@/types";
import * as utils from "../utils";

const fireworksProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post(
        "/fireworks/v1/chat/completions",
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.FireworksAiChatCompletionsWithDefaultAgent,
                description: "Create a chat completion with Fireworks AI (uses default agent)",
                tags: ["llm-proxy"],
                body: Fireworks.API.ChatRequestSchema,
                headers: Fireworks.API.ChatHeadersSchema,
                response: constructResponseSchema(Fireworks.API.ChatResponseSchema),
            },
        },
        async (request, reply) => {
            const externalAgentId = utils.externalAgentId.getExternalAgentId(request.headers);
            const userId = await utils.userId.getUserId(request.headers);
            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                fireworksAdapterFactory,
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

export default fireworksProxyRoutes;
