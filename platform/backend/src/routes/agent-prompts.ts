import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentPromptModel } from "@/models";
import { constructResponseSchema, UuidIdSchema } from "@/types";

const AgentPromptSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  promptId: z.string(),
  order: z.number(),
  createdAt: z.date(),
});

const AgentPromptWithDetailsSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  promptId: z.string(),
  order: z.number(),
  createdAt: z.date(),
  prompt: z.object({
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    type: z.enum(["system", "regular"]),
    content: z.string(),
    version: z.number(),
    parentPromptId: z.string().nullable(),
    isActive: z.boolean(),
    createdBy: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
  }),
});

const AssignAgentPromptsSchema = z.object({
  systemPromptId: z.string().uuid().optional().nullable(),
  regularPromptIds: z.array(z.string().uuid()).optional(),
});

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
          z.array(AgentPromptWithDetailsSchema),
        ),
      },
    },
    async ({ params }, reply) => {
      try {
        const agentPrompts = await AgentPromptModel.findByAgentIdWithPrompts(
          params.agentId,
        );
        return reply.send(agentPrompts);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        response: constructResponseSchema(z.array(AgentPromptSchema)),
      },
    },
    async ({ params, body }, reply) => {
      try {
        const agentPrompts = await AgentPromptModel.replacePrompts({
          agentId: params.agentId,
          systemPromptId: body.systemPromptId || null,
          regularPromptIds: body.regularPromptIds || [],
        });

        return reply.send(agentPrompts);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params }, reply) => {
      try {
        const success = await AgentPromptModel.delete(
          params.agentId,
          params.promptId,
        );

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Agent prompt not found",
              type: "not_found",
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
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

export default agentPromptRoutes;
