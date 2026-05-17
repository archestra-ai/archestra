import fastifyHttpProxy from "@fastify/http-proxy";
import { MCP_CATALOG_API_BASE_URL } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import logger from "@/logging";
import { ARCHESTRA_CATALOG_PROXY_PREFIX } from "./route-paths";

const archestraCatalogProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  logger.info(
    {
      prefix: ARCHESTRA_CATALOG_PROXY_PREFIX,
      upstream: MCP_CATALOG_API_BASE_URL,
    },
    "[ArchestraCatalogProxy] Registering catalog proxy",
  );

  await fastify.register(fastifyHttpProxy, {
    upstream: MCP_CATALOG_API_BASE_URL,
    prefix: ARCHESTRA_CATALOG_PROXY_PREFIX,
    rewritePrefix: "",
  });
};

export default archestraCatalogProxyRoutes;
