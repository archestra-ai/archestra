import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { ToolModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createPaginatedResponseSchema,
  ExtendedToolSchema,
  PaginationQuerySchema,
  ToolFilterSchema,
  ToolSortBySchema,
  ToolSortDirectionSchema,
  UuidIdSchema,
} from "@/types";

const toolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/tools",
    {
      schema: {
        operationId: RouteId.GetTools,
        description: "Get all tools",
        tags: ["Tools"],
        querystring: ToolFilterSchema.extend({
          sortBy: ToolSortBySchema.optional(),
          sortDirection: ToolSortDirectionSchema.optional(),
        }).merge(PaginationQuerySchema),
        response: constructResponseSchema(
          createPaginatedResponseSchema(ExtendedToolSchema),
        ),
      },
    },
    async (
      {
        user,
        headers,
        query: {
          limit,
          offset,
          sortBy,
          sortDirection,
          search,
          agentId,
          origin,
          mcpServerOwnerId,
          excludeArchestraTools,
        },
      },
      reply,
    ) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const result = await ToolModel.findAllPaginated(
        { limit, offset },
        { sortBy, sortDirection },
        {
          search,
          agentId,
          origin,
          mcpServerOwnerId,
          excludeArchestraTools,
        },
        user.id,
        isAgentAdmin,
      );

      return reply.send(result);
    },
  );

  fastify.get(
    "/api/tools/:toolId",
    {
      schema: {
        operationId: RouteId.GetTool,
        description: "Get a tool by ID",
        tags: ["Tools"],
        params: z.object({
          toolId: UuidIdSchema,
        }),
        response: constructResponseSchema(ExtendedToolSchema),
      },
    },
    async ({ params: { toolId }, user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const tool = await ToolModel.findById(toolId, user.id, isAgentAdmin);
      if (!tool) {
        throw new ApiError(404, "Tool not found");
      }
      return reply.send(tool);
    },
  );
};

export default toolRoutes;
