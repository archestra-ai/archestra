import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { ToolModel } from "@/models";
import { constructResponseSchema, ExtendedSelectToolSchema } from "@/types";

const toolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/tools",
    {
      schema: {
        operationId: RouteId.GetTools,
        description: "Get all tools",
        tags: ["Tools"],
        response: constructResponseSchema(z.array(ExtendedSelectToolSchema)),
      },
    },
    async ({ user, headers }, reply) => {
      try {
        const { success: isAgentAdmin } = await hasPermission(
          { agent: ["admin"] },
          headers,
        );

        return reply.send(await ToolModel.findAll(user.id, isAgentAdmin));
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default toolRoutes;
