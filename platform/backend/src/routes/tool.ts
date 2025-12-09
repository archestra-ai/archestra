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
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      return reply.send(await ToolModel.findAll(user.id, isAgentAdmin));
    },
  );
};

export default toolRoutes;
