import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { AgentTeamModel, PromptModel, ToolModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertPromptSchema,
  PromptVersionsResponseSchema,
  SelectPromptSchema,
  SelectToolSchema,
  UpdatePromptSchema,
  UuidIdSchema,
} from "@/types";

const promptRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/prompts",
    {
      schema: {
        operationId: RouteId.GetPrompts,
        description:
          "Get all prompts for the organization filtered by user's accessible agents",
        tags: ["Prompts"],
        response: constructResponseSchema(z.array(SelectPromptSchema)),
      },
    },
    async ({ organizationId, user, headers }, reply) => {
      // Check if user is an agent admin
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // Get accessible agent IDs for this user
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        user.id,
        isAgentAdmin,
      );

      // Filter prompts to only those assigned to accessible agents
      const prompts = await PromptModel.findByOrganizationIdAndAccessibleAgents(
        organizationId,
        accessibleAgentIds,
      );

      return reply.send(prompts);
    },
  );

  fastify.post(
    "/api/prompts",
    {
      schema: {
        operationId: RouteId.CreatePrompt,
        description: "Create a new prompt",
        tags: ["Prompts"],
        body: InsertPromptSchema,
        response: constructResponseSchema(SelectPromptSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      return reply.send(await PromptModel.create(organizationId, body));
    },
  );

  fastify.get(
    "/api/prompts/:id",
    {
      schema: {
        operationId: RouteId.GetPrompt,
        description: "Get a specific prompt by ID",
        tags: ["Prompts"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectPromptSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const prompt = await PromptModel.findByIdAndOrganizationId(
        id,
        organizationId,
      );

      if (!prompt) {
        throw new ApiError(404, "Prompt not found");
      }

      return reply.send(prompt);
    },
  );

  fastify.patch(
    "/api/prompts/:id",
    {
      schema: {
        operationId: RouteId.UpdatePrompt,
        description: "Update a prompt",
        tags: ["Prompts"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdatePromptSchema,
        response: constructResponseSchema(SelectPromptSchema),
      },
    },
    async ({ params, body, organizationId }, reply) => {
      // Verify the prompt belongs to this organization
      const existingPrompt = await PromptModel.findByIdAndOrganizationId(
        params.id,
        organizationId,
      );

      if (!existingPrompt) {
        throw new ApiError(404, "Prompt not found");
      }

      const updated = await PromptModel.update(params.id, body);

      if (!updated) {
        throw new ApiError(404, "Prompt not found");
      }

      return reply.send(updated);
    },
  );

  fastify.get(
    "/api/prompts/:id/versions",
    {
      schema: {
        operationId: RouteId.GetPromptVersions,
        description: "Get all versions of a prompt (current + history)",
        tags: ["Prompts"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(PromptVersionsResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const versions = await PromptModel.findVersions(id);

      if (!versions) {
        throw new ApiError(404, "Prompt not found");
      }

      // Verify prompt belongs to this organization
      if (versions.current.organizationId !== organizationId) {
        throw new ApiError(404, "Prompt not found");
      }

      return reply.send(versions);
    },
  );

  // Schema for prompt tools with agentPromptId mapping
  const PromptToolWithAgentSchema = SelectToolSchema.extend({
    agentPromptId: z.string().uuid(),
  });

  fastify.get(
    "/api/prompts/:id/tools",
    {
      schema: {
        operationId: RouteId.GetPromptTools,
        description:
          "Get agent delegation tools for a prompt (tools created from prompt agents)",
        tags: ["Prompts"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(z.array(PromptToolWithAgentSchema)),
      },
    },
    async ({ params: { id }, organizationId, user, headers }, reply) => {
      // Verify the prompt belongs to this organization
      const prompt = await PromptModel.findByIdAndOrganizationId(
        id,
        organizationId,
      );

      if (!prompt) {
        throw new ApiError(404, "Prompt not found");
      }

      // Check if user is an agent admin
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // Get all agent delegation tools for this prompt
      const allToolsWithDetails =
        await ToolModel.getAgentDelegationToolsWithDetails(id);

      // Filter by user access
      const userAccessibleAgentIds =
        await AgentTeamModel.getUserAccessibleAgentIds(user.id, isAgentAdmin);

      // Return tools with agentPromptId for mapping
      const accessibleTools = allToolsWithDetails
        .filter((t) => userAccessibleAgentIds.includes(t.profileId))
        .map((t) => ({
          ...t.tool,
          agentPromptId: t.agentPromptId,
        }));

      return reply.send(accessibleTools);
    },
  );

  fastify.post(
    "/api/prompts/:id/rollback",
    {
      schema: {
        operationId: RouteId.RollbackPrompt,
        description: "Rollback to a specific version of a prompt",
        tags: ["Prompts"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          version: z.number().int().positive(),
        }),
        response: constructResponseSchema(SelectPromptSchema),
      },
    },
    async ({ params: { id }, body: { version }, organizationId }, reply) => {
      // Verify the prompt belongs to this organization
      const existingPrompt = await PromptModel.findByIdAndOrganizationId(
        id,
        organizationId,
      );

      if (!existingPrompt) {
        throw new ApiError(404, "Prompt not found");
      }

      const rolledBack = await PromptModel.rollback(id, version);

      if (!rolledBack) {
        throw new ApiError(400, "Invalid version or rollback failed");
      }

      return reply.send(rolledBack);
    },
  );

  fastify.delete(
    "/api/prompts/:id",
    {
      schema: {
        operationId: RouteId.DeletePrompt,
        description: "Delete a prompt and all its versions",
        tags: ["Prompts"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      // Verify the prompt belongs to this organization
      const existingPrompt = await PromptModel.findByIdAndOrganizationId(
        id,
        organizationId,
      );

      if (!existingPrompt) {
        throw new ApiError(404, "Prompt not found");
      }

      const success = await PromptModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Prompt not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default promptRoutes;
