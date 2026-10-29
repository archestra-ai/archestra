import {
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { McpToolCallModel } from "@/models";
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
          "Get MCP tool calls in the active organization with cursor pagination, newest first. `log:read` returns rows attributed to the caller. `log:admin` includes every row in the organization. Each row's `sessionId` names the LLM proxy session that issued it, when known, and `llmToolCallId` the model's own id for the call.",
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
            userId: z
              .string()
              .optional()
              .describe(
                "Filter by the user the call is attributed to. Ignored without `log:admin`, which already scopes the listing to the caller.",
              ),
            sessionId: z
              .string()
              .min(1)
              .max(1024)
              .optional()
              .describe(
                "Filter by the LLM proxy session that issued the call: calls recorded with that session, and tool calls whose run resolves to it.",
              ),
          })
          .merge(CursorQuerySchema),
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
          mcpServerName,
          userId,
          sessionId,
          limit,
          cursor,
        },
        user,
        organizationId,
      },
      reply,
    ) => {
      const cursorQuery = { limit, cursor };
      // log:read scopes the view to the caller's own attributed rows;
      // log:admin lifts it within the active organization.
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
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
            sessionId,
            ownUserId: canSeeAllLogs ? userId : user.id,
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
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      const mcpToolCall = await McpToolCallModel.findById({
        id: mcpToolCallId,
        organizationId,
        ownUserId: canSeeAllLogs ? undefined : user.id,
      });

      if (!mcpToolCall) {
        throw new ApiError(404, "MCP tool call not found");
      }

      // Own-logs view: someone else's (or unattributed) row does not exist
      // for this caller — 404, not 403, so existence is not disclosed.
      if (!canSeeAllLogs && mcpToolCall.userId !== user.id) {
        throw new ApiError(404, "MCP tool call not found");
      }

      return reply.send(mcpToolCall);
    },
  );
};

export default mcpToolCallRoutes;
