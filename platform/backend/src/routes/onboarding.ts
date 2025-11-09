import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import { AgentModel } from "@/models";
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

  // Complete onboarding by creating a minimal interaction log
  fastify.post(
    "/api/onboarding/complete",
    {
      schema: {
        operationId: RouteId.CompleteOnboarding,
        description:
          "Mark onboarding as complete by creating a minimal interaction log",
        tags: ["Onboarding"],
        response: {
          200: z.object({
            success: z.boolean(),
          }),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ organizationId }, reply) => {
      try {
        // Get the default agent for this organization
        const defaultAgent =
          await AgentModel.getAgentOrCreateDefault(organizationId);

        // Create a minimal interaction log to mark onboarding as complete
        await db.insert(schema.interactionsTable).values({
          agentId: defaultAgent.id,
          type: "openai:chatCompletions",
          model: "onboarding-complete",
          request: {
            model: "onboarding-complete",
            messages: [
              {
                role: "system",
                content: "Onboarding complete marker",
              },
            ],
          },
          response: {
            id: "onboarding-complete",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "onboarding-complete",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Onboarding complete",
                },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          },
          inputTokens: 0,
          outputTokens: 0,
        });

        return reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({
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

export default onboardingRoutes;
