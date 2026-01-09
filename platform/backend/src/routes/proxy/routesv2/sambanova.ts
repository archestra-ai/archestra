import { SambaNova } from "@/types";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sambanovaAdapterFactory } from "../adapterV2";
import { PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { constructResponseSchema } from "@/types";
import * as utils from "../utils";

const sambanovaProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post(
        "/sambanova/v1/chat/completions",
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.SambaNovaAiChatCompletionsWithDefaultAgent,
                description: "Create a chat completion with SambaNova (uses default agent)",
                tags: ["llm-proxy"],
                body: SambaNova.API.ChatRequestSchema,
                headers: SambaNova.API.ChatHeadersSchema,
                response: constructResponseSchema(SambaNova.API.ChatResponseSchema),
            },
        },
        async (request, reply) => {
            const externalAgentId = utils.externalAgentId.getExternalAgentId(request.headers);
            const userId = await utils.userId.getUserId(request.headers);
            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                sambanovaAdapterFactory,
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

export default sambanovaProxyRoutes;
