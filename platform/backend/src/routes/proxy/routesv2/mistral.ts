import type { FastifyPluginAsync } from "fastify";
import { mistralAdapterFactory } from "../adapterV2";
import { handleLLMProxy } from "../llm-proxy-handler";

import * as utils from "../utils";

import { PROXY_API_PREFIX } from "../common";

const mistralRoutes: FastifyPluginAsync = async (fastify) => {
    const API_PREFIX = `${PROXY_API_PREFIX}/mistral`;
    fastify.post(`${API_PREFIX}/v1/chat/completions`, async (request, reply) => {
        const externalAgentId = utils.externalAgentId.getExternalAgentId(request.headers);
        const userId = await utils.userId.getUserId(request.headers);

        return handleLLMProxy(
            request.body,
            request.headers,
            reply,
            mistralAdapterFactory,
            {
                organizationId: request.organizationId,
                agentId: undefined,
                externalAgentId,
                userId,
            }
        );
    });
};

export default mistralRoutes;
