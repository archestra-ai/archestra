import type { FastifyPluginAsync } from "fastify";
import { deepseekAdapterFactory } from "../adapterV2";
import { handleLLMProxy } from "../llm-proxy-handler";

import * as utils from "../utils";

import { PROXY_API_PREFIX } from "../common";

const deepseekRoutes: FastifyPluginAsync = async (fastify) => {
    const API_PREFIX = `${PROXY_API_PREFIX}/deepseek`;
    fastify.post(`${API_PREFIX}/v1/chat/completions`, async (request, reply) => {
        const externalAgentId = utils.externalAgentId.getExternalAgentId(request.headers);
        const userId = await utils.userId.getUserId(request.headers);

        return handleLLMProxy(
            request.body,
            request.headers,
            reply,
            deepseekAdapterFactory,
            {
                organizationId: request.organizationId,
                agentId: undefined,
                externalAgentId,
                userId,
            }
        );
    });
};

export default deepseekRoutes;
