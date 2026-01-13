import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { ToolModel } from "@/models";
import {
  constructResponseSchema,
  createPaginatedResponseSchema,
  ExtendedSelectToolSchema,
  PaginationQuerySchema,
  ToolFilterSchema,
  ToolSortBySchema,
  ToolSortDirectionSchema,
  ToolWithAssignmentsSchema,
} from "@/types";

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

  fastify.get(
    "/api/tools/with-assignments",
    {
      schema: {
        operationId: RouteId.GetToolsWithAssignments,
        description:
          "Get all tools with their profile assignments (one entry per tool)",
        tags: ["Tools"],
        querystring: ToolFilterSchema.extend({
          sortBy: ToolSortBySchema.optional(),
          sortDirection: ToolSortDirectionSchema.optional(),
        }).merge(PaginationQuerySchema),
        response: constructResponseSchema(
          createPaginatedResponseSchema(ToolWithAssignmentsSchema),
        ),
      },
    },
    async (
      {
        query: {
          limit,
          offset,
          sortBy,
          sortDirection,
          search,
          origin,
          excludeArchestraTools,
        },
        headers,
        user,
      },
      reply,
    ) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const result = await ToolModel.findAllWithAssignments({
        pagination: { limit, offset },
        sorting: { sortBy, sortDirection },
        filters: {
          search,
          origin,
          excludeArchestraTools,
        },
        userId: user.id,
        isAgentAdmin,
      });

      return reply.send(result);
    },
  );

  fastify.delete(
    "/api/tools/:id",
    {
      schema: {
        operationId: RouteId.DeleteTool,
        description:
          "Delete an auto-discovered tool (tools without an MCP server)",
        tags: ["Tools"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id } }, reply) => {
      const success = await ToolModel.delete(id);
      if (!success) {
        return reply.status(404).send({
          error: {
            message: "Tool not found or cannot be deleted",
            type: "api_not_found_error",
          },
        });
      }
      return reply.send({ success: true });
    },
  );
};

export default toolRoutes;
