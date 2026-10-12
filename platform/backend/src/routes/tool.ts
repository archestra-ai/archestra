import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { ToolModel } from "@/models";
import {
  constructResponseSchema,
  createSortingQuerySchema,
  ExtendedSelectToolSchema,
  ToolFilterSchema,
  ToolSortBy,
  ToolWithAssignmentsSchema,
} from "@/types";

const toolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/tools",
    {
      schema: {
        operationId: RouteId.GetTools,
        description: "Get a paginated list of tools",
        tags: ["Tools"],
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(ExtendedSelectToolSchema),
        ),
      },
    },
    async ({ query, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      return reply.send(
        await ToolModel.findAll({
          userId: user.id,
          isAgentAdmin,
          pagination: query,
        }),
      );
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
          observedByUserId,
          observedByClient,
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
          observedByUserId,
          observedByClient,
          excludeArchestraTools,
          includeKnowledgeSourcesTool,
        },
        userId: user.id,
        isAgentAdmin,
      });

      return reply.send(result);
    },
  );
};

export default toolRoutes;
