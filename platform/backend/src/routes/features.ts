import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";

const featuresRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/features",
    {
      schema: {
        operationId: RouteId.GetFeatures,
        description: "Get feature flags",
        tags: ["Features"],
        response: {
          200: z.strictObject({
            /**
             * NOTE: add feature flags here, example:
             * mcp_registry: z.boolean(),
             */
            "orchestrator-k8s-runtime": z.boolean(),
          }),
        },
      },
    },
    async (_request, reply) =>
      reply.send({
        ...config.features,
        "orchestrator-k8s-runtime": McpServerRuntimeManager.isEnabled,
      }),
  );
};

export default featuresRoutes;
