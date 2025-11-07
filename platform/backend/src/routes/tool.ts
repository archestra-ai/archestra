import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ToolModel } from "@/models";
import {
  constructResponseSchema,
  ExtendedSelectToolSchema,
  RouteId,
} from "@/types";
import { getUserFromRequest } from "@/utils";

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
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const tools = await ToolModel.findAll(user.id);
        return reply.send(tools);
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

  fastify.get(
    "/api/tools/unassigned",
    {
      schema: {
        operationId: RouteId.GetUnassignedTools,
        description: "Get all tools that have no agent relationships",
        tags: ["Tools"],
        response: constructResponseSchema(z.array(ExtendedSelectToolSchema)),
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const tools = await ToolModel.findUnassigned();
        return reply.send(tools);
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
