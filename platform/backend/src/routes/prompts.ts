import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { PromptType } from "@/database/schemas/prompt";
import { PromptModel } from "@/models";
import { constructResponseSchema, UuidIdSchema } from "@/types";

const PromptSchema = z.object({
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
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
});

const CreatePromptSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["system", "regular"]),
  content: z.string().min(1),
});

const UpdatePromptSchema = z.object({
  name: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
});

const promptRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/prompts",
    {
      schema: {
        operationId: RouteId.GetPrompts,
        description: "Get all prompts for the organization",
        tags: ["Prompts"],
        querystring: z.object({
          type: z.enum(["system", "regular"]).optional(),
        }),
        response: constructResponseSchema(z.array(PromptSchema)),
      },
    },
    async ({ organizationId, query }, reply) => {
      try {
        const prompts = await PromptModel.findByOrganizationId(
          organizationId,
          query.type as PromptType | undefined,
        );
        return reply.send(prompts);
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

  fastify.post(
    "/api/prompts",
    {
      schema: {
        operationId: RouteId.CreatePrompt,
        description: "Create a new prompt",
        tags: ["Prompts"],
        body: CreatePromptSchema,
        response: constructResponseSchema(PromptSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      try {
        const prompt = await PromptModel.create({
          organizationId,
          name: body.name,
          type: body.type as PromptType,
          content: body.content,
          createdBy: user.id,
        });
        return reply.send(prompt);
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
        response: constructResponseSchema(PromptSchema),
      },
    },
    async ({ params }, reply) => {
      try {
        const prompt = await PromptModel.findById(params.id);

        if (!prompt) {
          return reply.status(404).send({
            error: {
              message: "Prompt not found",
              type: "not_found",
            },
          });
        }

        return reply.send(prompt);
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
        response: constructResponseSchema(z.array(PromptSchema)),
      },
    },
    async ({ params }, reply) => {
      try {
        const versions = await PromptModel.findVersions(params.id);

        if (versions.length === 0) {
          return reply.status(404).send({
            error: {
              message: "Prompt not found",
              type: "not_found",
            },
          });
        }

        return reply.send(versions);
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
        response: constructResponseSchema(PromptSchema),
      },
    },
    async ({ params, body, user }, reply) => {
      try {
        const updated = await PromptModel.update(params.id, {
          name: body.name,
          content: body.content,
          createdBy: user.id,
        });

        if (!updated) {
          return reply.status(404).send({
            error: {
              message: "Prompt not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updated);
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
    "/api/prompts/:id",
    {
      schema: {
        operationId: RouteId.DeletePrompt,
        description: "Delete a prompt and all its versions",
        tags: ["Prompts"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params }, reply) => {
      try {
        const success = await PromptModel.delete(params.id);

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Prompt not found",
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

export default promptRoutes;
