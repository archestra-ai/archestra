import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { PromptModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertPromptSchema,
  PromptTypeSchema,
  SelectPromptWithAgentsSchema,
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
        querystring: z.object({
          type: PromptTypeSchema.optional(),
        }),
        response: constructResponseSchema(
          z.array(SelectPromptWithAgentsSchema),
        ),
      },
    },
    async ({ organizationId, query }, reply) => {
      return reply.send(
        await PromptModel.findByOrganizationId(organizationId, query.type),
      );
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
        response: constructResponseSchema(SelectPromptWithAgentsSchema),
      },
    },
    async ({ body: { name, type, content }, organizationId, user }, reply) => {
      return reply.send(
        await PromptModel.create(organizationId, user.id, {
          name,
          type,
          content,
        }),
      );
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
        response: constructResponseSchema(SelectPromptWithAgentsSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      const prompt = await PromptModel.findById(id);

      if (!prompt) {
        throw new ApiError(404, "Prompt not found");
      }

      return reply.send(prompt);
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
        response: constructResponseSchema(
          z.array(SelectPromptWithAgentsSchema),
        ),
      },
    },
    async ({ params: { id } }, reply) => {
      const versions = await PromptModel.findVersions(id);

      if (versions.length === 0) {
        throw new ApiError(404, "Prompt not found");
      }

      return reply.send(versions);
    },
  );

  fastify.patch(
    "/api/prompts/:id",
    {
      schema: {
        operationId: RouteId.UpdatePrompt,
        description:
          "Update a prompt (creates a new version, deactivates old version)",
        tags: ["Prompts"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdatePromptSchema,
        response: constructResponseSchema(SelectPromptWithAgentsSchema),
      },
    },
    async ({ params, body: { name, content }, user }, reply) => {
      const updated = await PromptModel.update(params.id, user.id, {
        name,
        content,
      });

      if (!updated) {
        throw new ApiError(404, "Prompt not found");
      }

      return reply.send(updated);
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
    async ({ params: { id } }, reply) => {
      const success = await PromptModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Prompt not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default promptRoutes;
