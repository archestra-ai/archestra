import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { ToolModel, ToolPolicyModel } from "@/models";
import {
  constructPaginatedResponseSchema,
  constructResponseSchema,
  ExtendedSelectToolSchema,
  PaginationQuerySchema,
  SelectToolPolicySchema,
  ToolFilterSchema,
  ToolSortBySchema,
  ToolSortDirectionSchema,
  ToolWithAssignmentsSchema,
  UuidIdSchema,
} from "@/types";

const toolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // GET /api/tools - Get all tools with pagination, sorting, and filtering
  fastify.get(
    "/api/tools",
    {
      schema: {
        operationId: RouteId.GetTools,
        description: "Get all tools with pagination, sorting, and filtering",
        tags: ["Tools"],
        querystring: PaginationQuerySchema.merge(
          z.object({
            sortBy: ToolSortBySchema.optional(),
            sortDirection: ToolSortDirectionSchema.optional(),
            search: z.string().optional(),
            origin: z
              .string()
              .optional()
              .describe("Can be 'llm-proxy' or a catalogId"),
            excludeArchestraTools: z.coerce
              .boolean()
              .optional()
              .describe("For test isolation"),
          }),
        ),
        response: constructPaginatedResponseSchema(ToolWithAssignmentsSchema),
      },
    },
    async ({ user, headers, query }, reply) => {
      try {
        const { success: isAgentAdmin } = await hasPermission(
          { profile: ["admin"] },
          headers,
        );

        const { page = 1, limit = 10, sortBy, sortDirection, ...filters } = query;

        const result = await ToolModel.findAllPaginated(
          { page, limit, offset: (page - 1) * limit },
          { sortBy, sortDirection },
          filters,
          user.id,
          isAgentAdmin,
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

  // GET /api/tools/:id/policies - Get all policies for a specific tool
  fastify.get(
    "/api/tools/:id/policies",
    {
      schema: {
        operationId: RouteId.GetToolPoliciesByToolId,
        description: "Get all policies for a specific tool",
        tags: ["Tools"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(z.array(SelectToolPolicySchema)),
      },
    },
    async ({ params, headers }, reply) => {
      try {
        await hasPermission({ profile: ["read"] }, headers);

        const policies = await ToolPolicyModel.findAllByToolId(params.id);

        return reply.send(policies);
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
