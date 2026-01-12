import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import config from "@/config";
import logger from "@/logging";

const minimaxProxyRoutesV1: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = "/api/proxy/minimax";

  logger.info("[LegacyProxy] Registering legacy MiniMax routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.minimax?.baseUrl || "https://api.minimax.io/v1",
    prefix: API_PREFIX,
    rewritePrefix: "",
  });
};

export default minimaxProxyRoutesV1;
