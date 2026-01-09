import type { FastifyPluginAsync } from "fastify";
import { mistralAdapterFactory } from "../adapterV2";
import { handleLLMProxy } from "../utils";

const mistralRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post("/v1/chat/completions", async (request, reply) => {
        return handleLLMProxy({
            fastify,
            request,
            reply,
            adapterFactory: mistralAdapterFactory,
        });
    });
};

export default mistralRoutes;
