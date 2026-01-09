import { Novita } from "@/types";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { novitaAdapterFactory } from "../adapterV2";
import { PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { constructResponseSchema } from "@/types";
import * as utils from "../utils";

const novitaProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post(
        "/novita/v1/chat/completions",
        {
            bodyLimit: PROXY_BODY_LIMIT,
            schema: {
                operationId: RouteId.NovitaAiChatCompletionsWithDefaultAgent,
                description: "Create a chat completion with Novita (uses default agent)",
                tags: ["llm-proxy"],
                body: Novita.API.ChatRequestSchema,
                headers: Novita.API.ChatHeadersSchema,
                response: constructResponseSchema(Novita.API.ChatResponseSchema),
            },
        },
        async (request, reply) => {
            const externalAgentId = utils.externalAgentId.getExternalAgentId(request.headers);
            const userId = await utils.userId.getUserId(request.headers);
            return handleLLMProxy(
                request.body,
                request.headers,
                reply,
                novitaAdapterFactory,
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

export default novitaProxyRoutes;
