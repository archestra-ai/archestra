import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { DualLlmConfigModel } from "@/models";
import {
  ErrorResponseSchema,
  InsertDualLlmConfigSchema,
  SelectDualLlmConfigSchema,
  UuidIdSchema,
} from "@/types";

const dualLlmConfigRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get default configuration (or create if none exists)
  fastify.get(
    "/api/dual-llm-config/default",
    {
      schema: {
        operationId: "getDefaultDualLlmConfig",
        description: "Get default dual LLM configuration",
        tags: ["Dual LLM Config"],
        response: {
          200: SelectDualLlmConfigSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (_, reply) => {
      try {
        const config = await DualLlmConfigModel.getDefault();
        return reply.send(config);
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

  // Get all configurations
  fastify.get(
    "/api/dual-llm-config",
    {
      schema: {
        operationId: "getDualLlmConfigs",
        description: "Get all dual LLM configurations",
        tags: ["Dual LLM Config"],
        response: {
          200: z.array(SelectDualLlmConfigSchema),
          500: ErrorResponseSchema,
        },
      },
    },
    async (_, reply) => {
      try {
        const configs = await DualLlmConfigModel.findAll();
        return reply.send(configs);
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

  // Create a new configuration
  fastify.post(
    "/api/dual-llm-config",
    {
      schema: {
        operationId: "createDualLlmConfig",
        description: "Create a new dual LLM configuration",
        tags: ["Dual LLM Config"],
        body: InsertDualLlmConfigSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: SelectDualLlmConfigSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const config = await DualLlmConfigModel.create(request.body);
        return reply.send(config);
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

  // Get configuration by ID
  fastify.get(
    "/api/dual-llm-config/:id",
    {
      schema: {
        operationId: "getDualLlmConfig",
        description: "Get dual LLM configuration by ID",
        tags: ["Dual LLM Config"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: SelectDualLlmConfigSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id } }, reply) => {
      try {
        const config = await DualLlmConfigModel.findById(id);

        if (!config) {
          return reply.status(404).send({
            error: {
              message: "Configuration not found",
              type: "not_found",
            },
          });
        }

        return reply.send(config);
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

  // Update configuration
  fastify.put(
    "/api/dual-llm-config/:id",
    {
      schema: {
        operationId: "updateDualLlmConfig",
        description: "Update a dual LLM configuration",
        tags: ["Dual LLM Config"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: InsertDualLlmConfigSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }).partial(),
        response: {
          200: SelectDualLlmConfigSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id }, body }, reply) => {
      try {
        const config = await DualLlmConfigModel.update(id, body);

        if (!config) {
          return reply.status(404).send({
            error: {
              message: "Configuration not found",
              type: "not_found",
            },
          });
        }

        return reply.send(config);
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

  // Delete configuration
  fastify.delete(
    "/api/dual-llm-config/:id",
    {
      schema: {
        operationId: "deleteDualLlmConfig",
        description: "Delete a dual LLM configuration",
        tags: ["Dual LLM Config"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id } }, reply) => {
      try {
        const success = await DualLlmConfigModel.delete(id);

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Configuration not found",
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

export default dualLlmConfigRoutes;
