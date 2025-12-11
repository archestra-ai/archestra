import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { DualLlmConfigModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
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
      return reply.send(await DualLlmConfigModel.getDefault());
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
      return reply.send(await DualLlmConfigModel.findAll());
    },
  );

  fastify.post(
    "/api/dual-llm-config",
    {
      schema: {
        operationId: RouteId.CreateDualLlmConfig,
        description: "Create a new dual LLM configuration",
        tags: ["Dual LLM Config"],
        body: InsertDualLlmConfigSchema,
        response: constructResponseSchema(SelectDualLlmConfigSchema),
      },
    },
    async ({ body }, reply) => {
      return reply.send(await DualLlmConfigModel.create(body));
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
      const config = await DualLlmConfigModel.findById(id);

      if (!config) {
        throw new ApiError(404, "Configuration not found");
      }

      return reply.send(config);
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
        body: InsertDualLlmConfigSchema.partial(),
        response: constructResponseSchema(SelectDualLlmConfigSchema),
      },
    },
    async ({ params: { id }, body }, reply) => {
      const config = await DualLlmConfigModel.update(id, body);

      if (!config) {
        throw new ApiError(404, "Configuration not found");
      }

      return reply.send(config);
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
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      const success = await DualLlmConfigModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Configuration not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default dualLlmConfigRoutes;
