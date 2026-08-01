import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission, userHasPermission } from "@/auth";
import { createPaginatedResult } from "@/database/utils/pagination";
import { AgentTeamModel, McpToolCallModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createSortingQuerySchema,
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
        organizationId,
        headers,
      },
      reply,
    ) => {
      const pagination = { limit, offset };
      const sorting = { sortBy, sortDirection };
      // log:read scopes the view to the caller's own attributed rows;
      // log:admin lifts it (agent-visibility filtering still applies).
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      const filters = {
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        search: search || undefined,
        ownUserId: canSeeAllLogs ? undefined : user.id,
      };

      if (agentId) {
        // The per-agent listing previously skipped the access filter
        // entirely; scope it like the main listing (own rows only without
        // log:admin, and the agent must be visible to the caller).
        const { success: isMcpServerAdmin } = await hasPermission(
          { mcpServerInstallation: ["admin"] },
          headers,
        );
        if (
          !isMcpServerAdmin &&
          !(await AgentTeamModel.userHasAgentAccess(user.id, agentId, false))
        ) {
          return reply.send(createPaginatedResult([], 0, pagination));
        }
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
        { mcpServerInstallation: ["admin"] },
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
    async (
      { params: { mcpToolCallId }, user, organizationId, headers },
      reply,
    ) => {
      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
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

      // Own-logs view: someone else's (or unattributed) row does not exist
      // for this caller — 404, not 403, so existence is not disclosed.
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      if (!canSeeAllLogs && mcpToolCall.userId !== user.id) {
        throw new ApiError(404, "MCP tool call not found");
      }

      return reply.send(mcpToolCall);
    },
  );
};

export default mcpToolCallRoutes;
