import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import { ErrorResponseSchema } from "@/types";

const onboardingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Check for logs (LLM proxy and MCP gateway requests)
  fastify.get(
    "/api/onboarding/logs-status",
    {
      schema: {
        operationId: RouteId.GetOnboardingLogsStatus,
        description:
          "Check if organization has any LLM proxy or MCP gateway logs",
        tags: ["Onboarding"],
        response: {
          200: z.object({
            hasLlmProxyLogs: z.boolean(),
            hasMcpGatewayLogs: z.boolean(),
          }),
          401: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      // Check for LLM proxy logs (interactions) - any records at all
      const [interaction] = await db
        .select()
        .from(schema.interactionsTable)
        .limit(1);
      const hasLlmProxyLogs = !!interaction;

      // Check for MCP gateway logs (mcp tool calls) - any records at all
      const [mcpToolCall] = await db
        .select()
        .from(schema.mcpToolCallsTable)
        .limit(1);
      const hasMcpGatewayLogs = !!mcpToolCall;

      return reply.send({
        hasLlmProxyLogs,
        hasMcpGatewayLogs,
      });
    },
  );
};

export default onboardingRoutes;
