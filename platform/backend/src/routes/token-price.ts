import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OptimizationRuleModel, TokenPriceModel } from "@/models";
import {
  ApiError,
  CreateTokenPriceSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectTokenPriceSchema,
  UpdateTokenPriceSchema,
  UuidIdSchema,
} from "@/types";

const tokenPriceRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/token-prices",
    {
      schema: {
        operationId: RouteId.GetTokenPrices,
        description: "Get all token prices",
        tags: ["Token Prices"],
        response: constructResponseSchema(z.array(SelectTokenPriceSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      // Ensure default token prices and optimization rules exist first
      // This sets correct pricing for cheaper models before generic $50 fallback
      if (organizationId) {
        await OptimizationRuleModel.ensureDefaultOptimizationRules(
          organizationId,
        );
      }

      // Ensure all models from interactions have pricing
      await TokenPriceModel.ensureAllModelsHavePricing();

      return reply.send(await TokenPriceModel.findAll());
    },
  );

  fastify.post(
    "/api/token-prices",
    {
      schema: {
        operationId: RouteId.CreateTokenPrice,
        description: "Create a new token price",
        tags: ["Token Prices"],
        body: CreateTokenPriceSchema,
        response: constructResponseSchema(SelectTokenPriceSchema),
      },
    },
    async (request, reply) => {
      // Check if model already exists
      const existingTokenPrice = await TokenPriceModel.findByModel(
        request.body.model,
      );
      if (existingTokenPrice) {
        throw new ApiError(409, "Token price for this model already exists");
      }

      return reply.send(await TokenPriceModel.create(request.body));
    },
  );

  fastify.get(
    "/api/token-prices/:id",
    {
      schema: {
        operationId: RouteId.GetTokenPrice,
        description: "Get a token price by ID",
        tags: ["Token Prices"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectTokenPriceSchema),
      },
    },
    async (request, reply) => {
      const tokenPrice = await TokenPriceModel.findById(request.params.id);

      if (!tokenPrice) {
        throw new ApiError(404, "Token price not found");
      }

      return reply.send(tokenPrice);
    },
  );

  fastify.put(
    "/api/token-prices/:id",
    {
      schema: {
        operationId: RouteId.UpdateTokenPrice,
        description: "Update a token price",
        tags: ["Token Prices"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateTokenPriceSchema,
        response: constructResponseSchema(SelectTokenPriceSchema),
      },
    },
    async ({ params: { id }, body }, reply) => {
      const tokenPrice = await TokenPriceModel.update(id, body);

      if (!tokenPrice) {
        throw new ApiError(404, "Token price not found");
      }

      return reply.send(tokenPrice);
    },
  );

  fastify.delete(
    "/api/token-prices/:id",
    {
      schema: {
        operationId: RouteId.DeleteTokenPrice,
        description: "Delete a token price",
        tags: ["Token Prices"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      const success = await TokenPriceModel.delete(request.params.id);

      if (!success) {
        throw new ApiError(404, "Token price not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default tokenPriceRoutes;
