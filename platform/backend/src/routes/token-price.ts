import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import TokenPriceModel from "@/models/token-price";
import { ErrorResponseSchema, RouteId } from "@/types";
import {
  CreateTokenPriceSchema,
  SelectTokenPriceSchema,
  UpdateTokenPriceSchema,
} from "@/types/token-price";
import { getUserFromRequest } from "@/utils";

const tokenPriceRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get all token prices
   */
  fastify.get(
    "/api/token-prices",
    {
      schema: {
        operationId: RouteId.GetTokenPrices,
        description: "Get all token prices",
        tags: ["Token Prices"],
        response: {
          200: z.array(SelectTokenPriceSchema),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
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

  /**
   * Create a new token price (Admin only)
   */
  fastify.post(
    "/api/token-prices",
    {
      schema: {
        operationId: RouteId.CreateTokenPrice,
        description: "Create a new token price (Admin only)",
        tags: ["Token Prices"],
        body: CreateTokenPriceSchema,
        response: {
          200: SelectTokenPriceSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
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

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can create token prices",
              type: "forbidden",
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

  /**
   * Get a token price by ID
   */
  fastify.get(
    "/api/token-prices/:id",
    {
      schema: {
        operationId: RouteId.GetTokenPrice,
        description: "Get a token price by ID",
        tags: ["Token Prices"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: {
          200: SelectTokenPriceSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
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

  /**
   * Update a token price (Admin only)
   */
  fastify.put(
    "/api/token-prices/:id",
    {
      schema: {
        operationId: RouteId.UpdateTokenPrice,
        description: "Update a token price (Admin only)",
        tags: ["Token Prices"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: UpdateTokenPriceSchema.omit({ id: true }),
        response: {
          200: SelectTokenPriceSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
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

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can update token prices",
              type: "forbidden",
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

  /**
   * Delete a token price (Admin only)
   */
  fastify.delete(
    "/api/token-prices/:id",
    {
      schema: {
        operationId: RouteId.DeleteTokenPrice,
        description: "Delete a token price (Admin only)",
        tags: ["Token Prices"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
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

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can delete token prices",
              type: "forbidden",
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
