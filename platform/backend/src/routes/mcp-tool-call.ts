import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { McpToolCallModel } from "@/models";
import {
  createPaginatedResponseSchema,
  createSortingQuerySchema,
  ErrorResponseSchema,
  PaginationQuerySchema,
  RouteId,
  SelectMcpToolCallSchema,
  UuidIdSchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

const mcpToolCallRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp-tool-calls",
    {
      schema: {
        operationId: RouteId.GetMcpToolCalls,
        description: "Get all MCP tool calls with pagination and sorting",
        tags: ["MCP Tool Call"],
        querystring: z
          .object({
            agentId: UuidIdSchema.optional().describe("Filter by agent ID"),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema([
              "createdAt",
              "agentId",
              "mcpServerName",
            ] as const),
          ),
        response: {
          200: createPaginatedResponseSchema(SelectMcpToolCallSchema),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const { agentId, limit, offset, sortBy, sortDirection } = request.query;
      const pagination = { limit, offset };
      const sorting = { sortBy, sortDirection };

      if (agentId) {
        const result =
          await McpToolCallModel.getAllMcpToolCallsForAgentPaginated(
            agentId,
            pagination,
            sorting,
          );
        return reply.send(result);
      }

      const result = await McpToolCallModel.findAllPaginated(
        pagination,
        sorting,
        user.id,
        user.isAdmin,
      );

      return reply.send(result);
    },
  );

  fastify.get(
    "/api/mcp-tool-calls/:mcpToolCallId",
    {
      schema: {
        operationId: RouteId.GetMcpToolCall,
        description: "Get MCP tool call by ID",
        tags: ["MCP Tool Call"],
        params: z.object({
          mcpToolCallId: UuidIdSchema,
        }),
        response: {
          200: SelectMcpToolCallSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const mcpToolCall = await McpToolCallModel.findById(
        request.params.mcpToolCallId,
        user.id,
        user.isAdmin,
      );

      if (!mcpToolCall) {
        return reply.status(404).send({
          error: {
            message: "MCP tool call not found",
            type: "not_found",
          },
        });
      }

      return reply.send(mcpToolCall);
    },
  );
};

export default mcpToolCallRoutes;
