import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { hasPermission } from "@/auth";
import { ToolModel } from "@/models";
import {
  constructResponseSchema,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  ToolFilterSchema,
  ToolListItemSchema,
  ToolSortBySchema,
  ToolSortDirectionSchema,
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
          createPaginatedResponseSchema(ToolListItemSchema),
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
};

export default toolRoutes;
