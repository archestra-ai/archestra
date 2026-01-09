import type { FastifyPluginAsync } from "fastify";
import { deepseekAdapterFactory } from "../adapterV2";
import { handleLLMProxy } from "../utils";

const deepseekRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post("/v1/chat/completions", async (request, reply) => {
        return handleLLMProxy({
            fastify,
            request,
            reply,
            adapterFactory: deepseekAdapterFactory,
        });
    });
};

export default deepseekRoutes;
