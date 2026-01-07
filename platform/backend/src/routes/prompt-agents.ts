import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { PromptAgentModel, PromptModel } from "@/models";
import { ApiError, constructResponseSchema, UuidIdSchema } from "@/types";

const PromptAgentWithDetailsSchema = z.object({
  id: z.string().uuid(),
  promptId: z.string().uuid(),
  agentPromptId: z.string().uuid(),
  createdAt: z.coerce.date(),
  name: z.string(),
  systemPrompt: z.string().nullable(),
  profileId: z.string().uuid(),
  profileName: z.string(),
});

const SyncPromptAgentsBodySchema = z.object({
  agentPromptIds: z.array(z.string().uuid()),
});

const SyncPromptAgentsResponseSchema = z.object({
  added: z.array(z.string().uuid()),
  removed: z.array(z.string().uuid()),
});

const PromptAgentConnectionSchema = z.object({
  id: z.string().uuid(),
  promptId: z.string().uuid(),
  agentPromptId: z.string().uuid(),
});

const promptAgentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get all prompt-agent connections for the organization
   * Used for canvas visualization
   */
  fastify.get(
    "/api/prompt-agents",
    {
      schema: {
        operationId: RouteId.GetAllPromptAgentConnections,
        description:
          "Get all prompt-agent connections for the organization (for canvas visualization)",
        tags: ["Prompt Agents"],
        response: constructResponseSchema(z.array(PromptAgentConnectionSchema)),
      },
    },
    async ({ organizationId, user, headers }, reply) => {
      // Check if user has admin access to profiles
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const connections = await PromptAgentModel.findAllByOrganizationId(
        organizationId,
        user.id,
        isAgentAdmin,
      );
      return reply.send(connections);
    },
  );

  /**
   * Get all agents assigned to a prompt
   */
  fastify.get(
    "/api/prompts/:promptId/agents",
    {
      schema: {
        operationId: RouteId.GetPromptAgents,
        description:
          "Get all agents assigned to a prompt, filtered by user access",
        tags: ["Prompt Agents"],
        params: z.object({
          promptId: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.array(PromptAgentWithDetailsSchema),
        ),
      },
    },
    async ({ params: { promptId }, organizationId }, reply) => {
      // Verify the prompt exists and belongs to this organization
      const prompt = await PromptModel.findByIdAndOrganizationId(
        promptId,
        organizationId,
      );

      if (!prompt) {
        throw new ApiError(404, "Prompt not found");
      }

      // Get agents with details
      // Note: User already has prompt:read permission to access this endpoint,
      // so we return all configured agents without additional filtering
      const agents = await PromptAgentModel.findByPromptIdWithDetails(promptId);

      return reply.send(agents);
    },
  );

  /**
   * Sync agents for a prompt (replace all with new list)
   */
  fastify.post(
    "/api/prompts/:promptId/agents",
    {
      schema: {
        operationId: RouteId.SyncPromptAgents,
        description: "Sync agents for a prompt - replaces all existing agents",
        tags: ["Prompt Agents"],
        params: z.object({
          promptId: UuidIdSchema,
        }),
        body: SyncPromptAgentsBodySchema,
        response: constructResponseSchema(SyncPromptAgentsResponseSchema),
      },
    },
    async (
      { params: { promptId }, body: { agentPromptIds }, organizationId },
      reply,
    ) => {
      // Verify the prompt exists and belongs to this organization
      const prompt = await PromptModel.findByIdAndOrganizationId(
        promptId,
        organizationId,
      );

      if (!prompt) {
        throw new ApiError(404, "Prompt not found");
      }

      // Verify all agent prompts exist and belong to this organization
      for (const agentPromptId of agentPromptIds) {
        const agentPrompt = await PromptModel.findByIdAndOrganizationId(
          agentPromptId,
          organizationId,
        );

        if (!agentPrompt) {
          throw new ApiError(
            400,
            `Agent prompt ${agentPromptId} not found or not accessible`,
          );
        }

        // Prevent self-assignment
        if (agentPromptId === promptId) {
          throw new ApiError(
            400,
            "A prompt cannot be assigned as its own agent",
          );
        }
      }

      const result = await PromptAgentModel.sync({
        promptId,
        agentPromptIds,
      });

      return reply.send(result);
    },
  );

  /**
   * Remove a specific agent from a prompt
   */
  fastify.delete(
    "/api/prompts/:promptId/agents/:agentPromptId",
    {
      schema: {
        operationId: RouteId.DeletePromptAgent,
        description: "Remove an agent from a prompt",
        tags: ["Prompt Agents"],
        params: z.object({
          promptId: UuidIdSchema,
          agentPromptId: UuidIdSchema,
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { promptId, agentPromptId }, organizationId }, reply) => {
      // Verify the prompt exists and belongs to this organization
      const prompt = await PromptModel.findByIdAndOrganizationId(
        promptId,
        organizationId,
      );

      if (!prompt) {
        throw new ApiError(404, "Prompt not found");
      }

      const success = await PromptAgentModel.delete({
        promptId,
        agentPromptId,
      });

      return reply.send({ success });
    },
  );
};

export default promptAgentRoutes;
