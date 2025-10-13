import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ToolModel } from "@/models";
import {
  ErrorResponseSchema,
  SelectToolSchema,
  SelectToolWithAgentSchema,
  UpdateToolSchema,
  UuidIdSchema,
} from "@/types";

const toolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/tools",
    {
      schema: {
        operationId: "getTools",
        description: "Get all tools",
        tags: ["Tools"],
        response: {
          200: z.array(SelectToolWithAgentSchema),
          500: ErrorResponseSchema,
        },
      },
    },
    async (_, reply) => {
      try {
        const tools = await ToolModel.findAll();
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

  fastify.patch(
    "/api/tools/:id",
    {
      schema: {
        operationId: "updateTool",
        description: "Update a tool",
        tags: ["Tools"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateToolSchema,
        response: {
          200: SelectToolSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id }, body }, reply) => {
      try {
        const tool = await ToolModel.update(id, body);

        if (!tool) {
          return reply.status(404).send({
            error: {
              message: "Tool not found",
              type: "not_found",
            },
          });
        }

        return reply.send(tool);
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
