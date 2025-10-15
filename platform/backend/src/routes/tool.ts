import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ToolModel } from "@/models";
import {
  createPaginatedResponseSchema,
  createSortingQuerySchema,
  ErrorResponseSchema,
  PaginationQuerySchema,
  SelectToolSchema,
  SelectToolWithAgentSchema,
  UpdateToolSchema,
  UuidIdSchema,
} from "@/types";

const ToolSortingQuerySchema = createSortingQuerySchema([
  "name",
  "createdAt",
  "updatedAt",
  "agentName",
] as const);

const toolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/tools",
    {
      schema: {
        operationId: "getTools",
        description: "Get all tools with pagination and sorting",
        tags: ["Tools"],
        querystring: PaginationQuerySchema.merge(ToolSortingQuerySchema),
        response: {
          200: createPaginatedResponseSchema(SelectToolWithAgentSchema),
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ query: { limit, offset, sortBy, sortDirection } }, reply) => {
      try {
        const result = await ToolModel.findAllPaginated(
          { limit, offset },
          { sortBy, sortDirection },
        );
        return reply.send(result);
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
