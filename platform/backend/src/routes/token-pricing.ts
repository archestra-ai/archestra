import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { TokenPricingModel } from "@/models";
import { RouteId } from "@/types";

const tokenPriceSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  model: z.string(),
  inputPricePer1M: z.string(),
  outputPricePer1M: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const updateTokenPriceSchema = z.object({
  id: z.string().uuid(),
  inputPricePer1M: z.string(),
  outputPricePer1M: z.string(),
});

const tokenPricingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get all token prices, auto-creating for new models found in interactions
  fastify.get(
    "/api/token-pricing",
    {
      config: {
        routeId: RouteId.GetTokenPricing,
      },
      schema: {
        operationId: RouteId.GetTokenPricing,
        description: "Get all token prices",
        tags: ["Token Pricing"],
        response: {
          200: z.array(tokenPriceSchema),
          500: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (_, reply) => {
      try {
        // This will auto-create prices for any new models found in interactions
        const prices = await TokenPricingModel.findOrCreateByModels();
        return reply.send(prices);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: "Failed to fetch token prices",
        });
      }
    },
  );

  // Update multiple token prices
  fastify.put(
    "/api/token-pricing",
    {
      config: {
        routeId: RouteId.UpdateTokenPricing,
      },
      schema: {
        operationId: RouteId.UpdateTokenPricing,
        description: "Update token prices",
        tags: ["Token Pricing"],
        body: z.object({
          prices: z.array(updateTokenPriceSchema),
        }),
        response: {
          200: z.array(tokenPriceSchema),
          400: z.object({
            error: z.string(),
          }),
          500: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      try {
        const { prices } = request.body;

        if (!prices || prices.length === 0) {
          return reply.status(400).send({
            error: "No prices provided to update",
          });
        }

        const updatedPrices = await TokenPricingModel.updateMany(prices);
        return reply.send(updatedPrices);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: "Failed to update token prices",
        });
      }
    },
  );
};

export default tokenPricingRoutes;
