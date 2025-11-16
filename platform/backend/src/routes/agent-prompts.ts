import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentPromptModel } from "@/models";
import {
  ApiError,
  AssignAgentPromptsSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectAgentPromptSchema,
  SelectAgentPromptWithDetailsSchema,
  UuidIdSchema,
} from "@/types";

const agentPromptRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agents/:agentId/prompts",
    {
      schema: {
        operationId: RouteId.GetAgentPrompts,
        description: "Get all prompts assigned to an agent",
        tags: ["Agent Prompts"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.array(SelectAgentPromptWithDetailsSchema),
        ),
      },
    },
    async ({ params: { agentId } }, reply) => {
      return reply.send(
        await AgentPromptModel.findByAgentIdWithPrompts(agentId),
      );
    },
  );

  fastify.put(
    "/api/agents/:agentId/prompts",
    {
      schema: {
        operationId: RouteId.AssignAgentPrompts,
        description:
          "Assign prompts to an agent (replaces all existing assignments)",
        tags: ["Agent Prompts"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: AssignAgentPromptsSchema,
        response: constructResponseSchema(z.array(SelectAgentPromptSchema)),
      },
    },
    async (
      { params: { agentId }, body: { systemPromptId, regularPromptIds } },
      reply,
    ) => {
      const agentPrompts = await AgentPromptModel.replacePrompts(agentId, {
        systemPromptId: systemPromptId || undefined,
        regularPromptIds: regularPromptIds || undefined,
      });

      return reply.send(agentPrompts);
    },
  );

  fastify.delete(
    "/api/agents/:agentId/prompts/:promptId",
    {
      schema: {
        operationId: RouteId.DeleteAgentPrompt,
        description: "Remove a prompt from an agent",
        tags: ["Agent Prompts"],
        params: z.object({
          agentId: UuidIdSchema,
          promptId: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params }, reply) => {
      const success = await AgentPromptModel.delete(
        params.agentId,
        params.promptId,
      );

      if (!success) {
        throw new ApiError(404, "Agent prompt not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default agentPromptRoutes;
