import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { ToolModel, ToolPolicyModel } from "@/models";
import {
  constructResponseSchema,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  SelectToolPolicySchema,
  ToolSortBySchema,
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
        querystring: ToolSortBySchema.merge(PaginationQuerySchema).merge(
          z.object({
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
        response: createPaginatedResponseSchema(ToolWithAssignmentsSchema),
      },
    },
    async ({ user, headers, query }, reply) => {
      try {
        const { success: isAgentAdmin } = await hasPermission(
          { profile: ["admin"] },
          headers,
        );

        const { limit, offset, sortBy, sortDirection, ...filters } = query;

        const result = await ToolModel.findAllPaginated(
          { limit, offset },
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
