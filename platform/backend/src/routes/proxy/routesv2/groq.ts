import type { FastifyPluginAsync } from "fastify";
import { groqAdapterFactory } from "../adapterV2";
import { handleLLMProxy } from "../llm-proxy-handler";

import * as utils from "../utils";

import { PROXY_API_PREFIX } from "../common";

const groqRoutes: FastifyPluginAsync = async (fastify) => {
    const API_PREFIX = `${PROXY_API_PREFIX}/groq`;
    fastify.post(`${API_PREFIX}/v1/chat/completions`, async (request, reply) => {
        const externalAgentId = utils.externalAgentId.getExternalAgentId(request.headers);
        const userId = await utils.userId.getUserId(request.headers);

        return handleLLMProxy(
            request.body,
            request.headers,
            reply,
            groqAdapterFactory,
            {
                organizationId: request.organizationId,
                agentId: undefined,
                externalAgentId,
                userId,
            }
        );
    });
};

export default groqRoutes;
