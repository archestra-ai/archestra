import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { RouteId } from "@shared";
import { z } from "zod";
import { InteractionModel, McpToolCallModel } from "@/models";
import { ErrorResponseSchema } from "@/types";
import { getUserFromRequest } from "@/utils";

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

      // Check for LLM proxy logs (interactions)
      const interactions = await InteractionModel.findAllPaginated(
        { limit: 1, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        user.id,
        user.isAdmin,
      );
      const hasLlmProxyLogs = interactions.data.length > 0;

      // Check for MCP gateway logs (mcp tool calls)
      const mcpToolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 1, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        user.id,
        user.isAdmin,
      );
      const hasMcpGatewayLogs = mcpToolCalls.data.length > 0;

      return reply.send({
        hasLlmProxyLogs,
        hasMcpGatewayLogs,
      });
    },
  );
};

export default onboardingRoutes;
