import {
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { McpToolCallModel } from "@/models";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  ApiError,
  constructResponseSchema,
  McpToolCallResponseSchema,
  UuidIdSchema,
} from "@/types";

const mcpToolCallRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp-tool-calls",
    {
      schema: {
        operationId: RouteId.GetMcpToolCalls,
        description:
          "Get MCP tool calls in the active organization with cursor pagination. `log:read` returns rows attributed to the caller. `log:admin` includes every row in the organization.",
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
            mcpServerName: z
              .string()
              .optional()
              .describe("Filter by exact MCP server name"),
          })
          .merge(CursorQuerySchema),
        response: constructResponseSchema(
          createCursorPaginatedResponseSchema(McpToolCallResponseSchema),
        ),
      },
    },
    async (
      {
        query: { agentId, startDate, endDate, mcpServerName, limit, cursor },
        user,
        organizationId,
      },
      reply,
    ) => {
      const cursorQuery = { limit, cursor };
      // log:read scopes the view to the caller's own attributed rows;
      // log:admin lifts it within the active organization.
      const canSeeAllLogs = await ResourcePermissions.allows({
        userId: user.id,
        organizationId: organizationId,
        resource: "log",
        scope: "*",
        action: "read",
      });
      return reply.send(
        await McpToolCallModel.findAllCursorPaginated(
          cursorQuery,
          undefined,
          undefined,
          {
            organizationId,
            agentId,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            mcpServerName,
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
        description:
          "Get an MCP tool call in the active organization by ID. `log:read` permits a row attributed to the caller. `log:admin` permits any row in the organization.",
        tags: ["MCP Tool Call"],
        params: z.object({
          mcpToolCallId: UuidIdSchema,
        }),
        response: constructResponseSchema(McpToolCallResponseSchema),
      },
    },
    async ({ params: { mcpToolCallId }, user, organizationId }, reply) => {
      const mcpToolCall = await McpToolCallModel.findById({
        id: mcpToolCallId,
        organizationId,
      });

      if (!mcpToolCall) {
        throw new ApiError(404, "MCP tool call not found");
      }

      // Own-logs view: someone else's (or unattributed) row does not exist
      // for this caller — 404, not 403, so existence is not disclosed.
      const canSeeAllLogs = await ResourcePermissions.allows({
        userId: user.id,
        organizationId: organizationId,
        resource: "log",
        scope: "*",
        action: "read",
      });
      if (!canSeeAllLogs && mcpToolCall.userId !== user.id) {
        throw new ApiError(404, "MCP tool call not found");
      }

      return reply.send(mcpToolCall);
    },
  );
};

export default mcpToolCallRoutes;
