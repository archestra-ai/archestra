import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { DualLlmConfigModel } from "@/models";
import {
  constructResponseSchema,
  InsertDualLlmConfigSchema,
  SelectDualLlmConfigSchema,
  UuidIdSchema,
} from "@/types";

const dualLlmConfigRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/dual-llm-config/default",
    {
      schema: {
        operationId: RouteId.GetDefaultDualLlmConfig,
        description: "Get default dual LLM configuration",
        tags: ["Dual LLM Config"],
        response: constructResponseSchema(SelectDualLlmConfigSchema),
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

  fastify.get(
    "/api/dual-llm-config",
    {
      schema: {
        operationId: RouteId.GetDualLlmConfigs,
        description: "Get all dual LLM configurations",
        tags: ["Dual LLM Config"],
        response: constructResponseSchema(z.array(SelectDualLlmConfigSchema)),
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

  fastify.post(
    "/api/dual-llm-config",
    {
      schema: {
        operationId: RouteId.CreateDualLlmConfig,
        description: "Create a new dual LLM configuration",
        tags: ["Dual LLM Config"],
        body: InsertDualLlmConfigSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: constructResponseSchema(SelectDualLlmConfigSchema),
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

  fastify.get(
    "/api/dual-llm-config/:id",
    {
      schema: {
        operationId: RouteId.GetDualLlmConfig,
        description: "Get dual LLM configuration by ID",
        tags: ["Dual LLM Config"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectDualLlmConfigSchema),
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

  fastify.put(
    "/api/dual-llm-config/:id",
    {
      schema: {
        operationId: RouteId.UpdateDualLlmConfig,
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
        response: constructResponseSchema(SelectDualLlmConfigSchema),
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

  fastify.delete(
    "/api/dual-llm-config/:id",
    {
      schema: {
        operationId: RouteId.DeleteDualLlmConfig,
        description: "Delete a dual LLM configuration",
        tags: ["Dual LLM Config"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
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
