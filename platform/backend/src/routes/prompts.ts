import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { PromptModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertPromptSchema,
  SelectPromptSchema,
  UpdatePromptSchema,
  UuidIdSchema,
} from "@/types";

const promptRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/prompts",
    {
      schema: {
        operationId: RouteId.GetPrompts,
        description: "Get all prompts for the organization",
        tags: ["Prompts"],
        response: constructResponseSchema(z.array(SelectPromptSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await PromptModel.findByOrganizationId(organizationId));
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
        description: "Get all versions of a prompt",
        tags: ["Prompts"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(z.array(SelectPromptSchema)),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const versions = await PromptModel.findVersions(id);

      if (versions.length === 0) {
        throw new ApiError(404, "Prompt not found");
      }

      // Verify first version belongs to this organization
      if (versions[0].organizationId !== organizationId) {
        throw new ApiError(404, "Prompt not found");
      }

      return reply.send(versions);
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
          versionId: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectPromptSchema),
      },
    },
    async ({ params: { id }, body: { versionId }, organizationId }, reply) => {
      // Verify the prompt belongs to this organization
      const existingPrompt = await PromptModel.findByIdAndOrganizationId(
        id,
        organizationId,
      );

      if (!existingPrompt) {
        throw new ApiError(404, "Prompt not found");
      }

      const rolledBack = await PromptModel.rollback(id, versionId);

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
