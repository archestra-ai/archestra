import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { RouteId } from "@/types";

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
            mcp_registry: z.boolean(),
          }),
        },
      },
    },
    async (_request, reply) => reply.send(config.features),
  );
};

export default featuresRoutes;
