import {
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission, userHasPermission } from "@/auth";
import { AgentTeamModel, McpToolCallModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  McpToolCallResponseSchema,
  SortDirectionSchema,
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
          .merge(CursorQuerySchema)
          .extend({
            sortDirection: SortDirectionSchema.optional().default("desc"),
          }),
        response: constructResponseSchema(
          createCursorPaginatedResponseSchema(McpToolCallResponseSchema),
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
          cursor,
          sortDirection,
        },
        user,
        organizationId,
        headers,
      },
      reply,
    ) => {
      const cursorQuery = { limit, cursor };
      // log:read scopes the view to the caller's own attributed rows;
      // log:admin lifts it (agent-visibility filtering still applies).
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        headers,
      );

      // The per-agent listing is the same query with one more predicate, so
      // it runs through the same method rather than a parallel one that has
      // to be kept in step with it.
      if (
        agentId &&
        !isMcpServerAdmin &&
        !(await AgentTeamModel.userHasAgentAccess(user.id, agentId, false))
      ) {
        return reply.send({
          data: [],
          pagination: { limit, hasNext: false, nextCursor: null },
        });
      }

      return reply.send(
        await McpToolCallModel.findAllCursorPaginated(
          cursorQuery,
          sortDirection,
          user.id,
          isMcpServerAdmin,
          {
            agentId,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            search: search || undefined,
            ownUserId: canSeeAllLogs ? undefined : user.id,
          },
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
        response: constructResponseSchema(McpToolCallResponseSchema),
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
