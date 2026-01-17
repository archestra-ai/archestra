import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { McpToolCallModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createPaginatedResponseSchema,
  createSortingQuerySchema,
  PaginationQuerySchema,
  SelectMcpToolCallSchema,
  UuidIdSchema,
} from "@/types";

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
            startDate: z
              .string()
              .datetime()
              .optional()
              .describe("Filter by start date (ISO 8601 format)"),
            endDate: z
              .string()
              .datetime()
              .optional()
              .describe("Filter by end date (ISO 8601 format)"),
            search: z
              .string()
              .optional()
              .describe(
                "Free-text search across MCP server name, tool name, and arguments (case-insensitive)",
              ),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema([
              "createdAt",
              "agentId",
              "mcpServerName",
              "method",
            ] as const),
          ),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectMcpToolCallSchema),
        ),
      },
    },
    async (
      {
        query: {
          agentId,
          startDate,
          endDate,
          search,
          limit,
          offset,
          sortBy,
          sortDirection,
        },
        user,
        headers,
      },
      reply,
    ) => {
      const pagination = { limit, offset };
      const sorting = { sortBy, sortDirection };
      const filters = {
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        search: search || undefined,
      };

      if (agentId) {
        return reply.send(
          await McpToolCallModel.getAllMcpToolCallsForAgentPaginated(
            agentId,
            pagination,
            sorting,
            undefined,
            filters,
          ),
        );
      }

      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServer: ["admin"] },
        headers,
      );

      return reply.send(
        await McpToolCallModel.findAllPaginated(
          pagination,
          sorting,
          user.id,
          isMcpServerAdmin,
          filters,
        ),
      );
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
        response: constructResponseSchema(SelectMcpToolCallSchema),
      },
    },
    async ({ params: { mcpToolCallId }, user, headers }, reply) => {
      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServer: ["admin"] },
        headers,
      );

      const mcpToolCall = await McpToolCallModel.findById(
        mcpToolCallId,
        user.id,
        isMcpServerAdmin,
      );

      if (!mcpToolCall) {
        throw new ApiError(404, "MCP tool call not found");
      }

      return reply.send(mcpToolCall);
    },
  );
};

export default mcpToolCallRoutes;
