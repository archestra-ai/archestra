import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import UsageAnalyticsModel from "@/models/usage-analytics";
import {
  ErrorResponseSchema,
  RouteId,
  type UsageBreakdown,
  UsageBreakdownSchema,
  UsageCostSummarySchema,
  UsageGroupBySchema,
  UsagePeriodSchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

const usageAnalyticsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/usage/breakdown",
    {
      schema: {
        operationId: RouteId.GetUsageBreakdown,
        description: "Get usage breakdown by different dimensions",
        tags: ["UsageAnalytics"],
        querystring: z.object({
          period: UsagePeriodSchema.default("daily"),
          groupBy: UsageGroupBySchema.default("team"),
        }),
        response: {
          200: z.array(UsageBreakdownSchema),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const { period, groupBy } = request.query;

      let result: UsageBreakdown[] = [];

      switch (groupBy) {
        case "team":
          result = await UsageAnalyticsModel.getCostBreakdownByTeams(
            period,
            user.id,
            user.isAdmin,
          );
          break;
        case "agent":
          result = await UsageAnalyticsModel.getCostBreakdownByAgents(
            period,
            user.id,
            user.isAdmin,
          );
          break;
        case "provider":
          result = await UsageAnalyticsModel.getCostBreakdownByProviders(
            period,
            user.id,
            user.isAdmin,
          );
          break;
        case "model":
          result = await UsageAnalyticsModel.getCostBreakdownByModels(
            period,
            user.id,
            user.isAdmin,
          );
          break;
      }

      return reply.send(result);
    },
  );

  fastify.get(
    "/api/usage/cost-summary",
    {
      schema: {
        operationId: RouteId.GetUsageCostSummary,
        description: "Get current spending summary",
        tags: ["UsageAnalytics"],
        querystring: z.object({
          period: UsagePeriodSchema.default("daily"),
        }),
        response: {
          200: UsageCostSummarySchema,
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const { period } = request.query;

      const currentSpend = await UsageAnalyticsModel.getCurrentSpend(
        period,
        user.id,
        user.isAdmin,
      );

      // TODO: Get budget limit from database when budget management is implemented
      const budgetLimit = 1000; // Default budget limit

      return reply.send({
        currentSpend,
        budgetLimit,
        period,
      });
    },
  );
};

export default usageAnalyticsRoutes;
