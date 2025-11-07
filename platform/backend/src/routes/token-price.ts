import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import TokenPriceModel from "@/models/token-price";
import {
  constructResponseSchema,
  ErrorResponseSchema,
  RouteId,
  UuidIdSchema,
} from "@/types";
import {
  CreateTokenPriceSchema,
  SelectTokenPriceSchema,
  UpdateTokenPriceSchema,
} from "@/types/token-price";
import { getUserFromRequest } from "@/utils";

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
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Ensure all models from interactions have pricing
        await TokenPriceModel.ensureAllModelsHavePricing();

        const tokenPrices = await TokenPriceModel.findAll();
        return reply.send(tokenPrices);
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
    "/api/token-prices",
    {
      schema: {
        operationId: RouteId.CreateTokenPrice,
        description: "Create a new token price",
        tags: ["Token Prices"],
        body: CreateTokenPriceSchema,
        response: {
          ...constructResponseSchema(SelectTokenPriceSchema),
          409: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Check if model already exists
        const existingTokenPrice = await TokenPriceModel.findByModel(
          request.body.model,
        );
        if (existingTokenPrice) {
          return reply.status(409).send({
            error: {
              message: "Token price for this model already exists",
              type: "conflict",
            },
          });
        }

        const tokenPrice = await TokenPriceModel.create(request.body);
        return reply.send(tokenPrice);
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
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const tokenPrice = await TokenPriceModel.findById(request.params.id);

        if (!tokenPrice) {
          return reply.status(404).send({
            error: {
              message: "Token price not found",
              type: "not_found",
            },
          });
        }

        return reply.send(tokenPrice);
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
    "/api/token-prices/:id",
    {
      schema: {
        operationId: RouteId.UpdateTokenPrice,
        description: "Update a token price",
        tags: ["Token Prices"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateTokenPriceSchema.omit({ id: true }),
        response: constructResponseSchema(SelectTokenPriceSchema),
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const tokenPrice = await TokenPriceModel.update(
          request.params.id,
          request.body,
        );

        if (!tokenPrice) {
          return reply.status(404).send({
            error: {
              message: "Token price not found",
              type: "not_found",
            },
          });
        }

        return reply.send(tokenPrice);
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
    "/api/token-prices/:id",
    {
      schema: {
        operationId: RouteId.DeleteTokenPrice,
        description: "Delete a token price",
        tags: ["Token Prices"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const success = await TokenPriceModel.delete(request.params.id);

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Token price not found",
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

export default tokenPriceRoutes;
