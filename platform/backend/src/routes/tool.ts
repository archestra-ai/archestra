import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { ToolModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createSortingQuerySchema,
  ExtendedSelectToolSchema,
  SelectToolSchema,
  ToolFilterSchema,
  ToolSortBy,
  ToolWithAssignmentsSchema,
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
        response: constructResponseSchema(z.array(ExtendedSelectToolSchema)),
      },
    },
    async ({ user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

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
        querystring: createSortingQuerySchema(ToolSortBy)
          .merge(ToolFilterSchema)
          .merge(PaginationQuerySchema),
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
          includeKnowledgeSourcesTool,
        },
        user,
        organizationId,
      },
      reply,
    ) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      const result = await ToolModel.findAllWithAssignments({
        pagination: { limit, offset },
        sorting: { sortBy, sortDirection },
        filters: {
          search,
          origin,
          excludeArchestraTools,
          includeKnowledgeSourcesTool,
        },
        userId: user.id,
        isAgentAdmin,
      });

      return reply.send(result);
    },
  );

  fastify.get(
    "/api/tools/:id",
    {
      schema: {
        operationId: RouteId.GetTool,
        description:
          "Get a single tool's policy-editor fields (id, name, parameters) by id, scoped to what the caller can access",
        tags: ["Tools"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(
          SelectToolSchema.pick({ id: true, name: true, parameters: true }),
        ),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      const tool = await ToolModel.findByIdForOrg({
        id,
        userId: user.id,
        organizationId,
        isAdmin: isAgentAdmin,
      });
      if (!tool) {
        throw new ApiError(404, `Tool with ID ${id} not found`);
      }

      return reply.send(tool);
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
