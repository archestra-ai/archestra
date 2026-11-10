import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isServiceAccountUserId } from "@/auth/service-account-user-id";
import {
  cancelBackfill,
  describeBackfill,
  startBackfillScan,
  startBackfillScoring,
} from "@/auto-routing/backfill";
import { diagnoseAutoRouting } from "@/auto-routing/diagnostics";
import { simulateFit } from "@/auto-routing/fit";
import { previewAutoRouting } from "@/auto-routing/preview";
import {
  createAutoRouter,
  deleteAutoRouter,
  getAutoRouter,
  getAutoRoutingState,
  listAutoRouters,
  loadAutoRouter,
  replanAutoRouter,
  setAutoRoutingEnabled,
  toPlanDetail,
  toPlanSummary,
  updateAutoRouter,
} from "@/auto-routing/settings";
import config from "@/config";
import AutoRouterModel from "@/models/auto-router";
import RoutingPlanModel from "@/models/routing-plan";
import {
  ApiError,
  constructResponseSchema,
  generateErrorResponseSchema,
  UuidIdSchema,
} from "@/types";
import {
  AutoRouterChangeResponseSchema,
  AutoRouterResponseSchema,
  AutoRoutingBackfillResponseSchema,
  AutoRoutingDiagnosticsQuerySchema,
  AutoRoutingDiagnosticsResponseSchema,
  AutoRoutingPlanDetailSchema,
  AutoRoutingPlanSummarySchema,
  AutoRoutingPlansQuerySchema,
  AutoRoutingPreviewBodySchema,
  AutoRoutingPreviewResponseSchema,
  AutoRoutingScoreBackfillBodySchema,
  AutoRoutingSimulateBodySchema,
  AutoRoutingSimulateResponseSchema,
  AutoRoutingStateResponseSchema,
  CreateAutoRouterBodySchema,
  UpdateAutoRouterBodySchema,
  UpdateAutoRoutingStateBodySchema,
} from "@/types/auto-routing-api";

const TAGS = ["Auto Routing"];
const RouterParamsSchema = z.object({ id: UuidIdSchema });

const autoRoutingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // onRequest, so a disabled deployment never parses a body.
  fastify.addHook("onRequest", async () => {
    if (!config.autoRouting.enabled) {
      throw new ApiError(404, "Auto routing is not enabled");
    }
  });

  fastify.get(
    "/api/auto-routing/state",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingState,
        description:
          "Get whether auto routing is on for the organization, and the keys and decision models its routers may use",
        tags: TAGS,
        response: constructResponseSchema(AutoRoutingStateResponseSchema),
      },
    },
    async ({ organizationId }, reply) =>
      reply.send(await getAutoRoutingState(organizationId)),
  );

  fastify.put(
    "/api/auto-routing/state",
    {
      schema: {
        operationId: RouteId.UpdateAutoRoutingState,
        description: "Turn auto routing on or off for the organization",
        tags: TAGS,
        body: UpdateAutoRoutingStateBodySchema,
        response: constructResponseSchema(AutoRoutingStateResponseSchema),
      },
    },
    async ({ organizationId, body }, reply) =>
      reply.send(await setAutoRoutingEnabled(organizationId, body.enabled)),
  );

  fastify.get(
    "/api/auto-routing/routers",
    {
      schema: {
        operationId: RouteId.GetAutoRouters,
        description:
          "List the organization's auto routers with their planning status",
        tags: TAGS,
        response: constructResponseSchema(z.array(AutoRouterResponseSchema)),
      },
    },
    async ({ organizationId }, reply) =>
      reply.send(await listAutoRouters(organizationId)),
  );

  fastify.get(
    "/api/auto-routing/routers/available",
    {
      schema: {
        operationId: RouteId.GetAvailableAutoRouters,
        description:
          "List the names of the organization's auto routers, for adding them to a virtual key",
        tags: TAGS,
        response: constructResponseSchema(
          z.array(
            z.object({
              id: z.string().uuid(),
              name: z.string(),
              virtualApiKeyIds: z.array(z.string().uuid()),
            }),
          ),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      const routers = await AutoRouterModel.list(organizationId);
      const keys = await AutoRouterModel.findVirtualApiKeyIds(
        routers.map((router) => router.id),
      );
      return reply.send(
        routers.map(({ id, name }) => ({
          id,
          name,
          virtualApiKeyIds: keys.get(id) ?? [],
        })),
      );
    },
  );

  fastify.post(
    "/api/auto-routing/routers",
    {
      schema: {
        operationId: RouteId.CreateAutoRouter,
        description:
          "Create an auto router with its tiers, budget and decision model. It learns from its own sessions only",
        tags: TAGS,
        body: CreateAutoRouterBodySchema,
        response: constructResponseSchema(AutoRouterChangeResponseSchema),
      },
    },
    async ({ organizationId, body }, reply) =>
      reply.send(await createAutoRouter(organizationId, body)),
  );

  fastify.get(
    "/api/auto-routing/routers/:id",
    {
      schema: {
        operationId: RouteId.GetAutoRouter,
        description: "Get an auto router's settings and planning status",
        tags: TAGS,
        params: RouterParamsSchema,
        response: constructResponseSchema(AutoRouterResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) =>
      reply.send(await getAutoRouter(organizationId, params.id)),
  );

  fastify.put(
    "/api/auto-routing/routers/:id",
    {
      schema: {
        operationId: RouteId.UpdateAutoRouter,
        description:
          "Update an auto router and fit a plan on it when auto routing is on",
        tags: TAGS,
        params: RouterParamsSchema,
        body: UpdateAutoRouterBodySchema,
        response: constructResponseSchema(AutoRouterChangeResponseSchema),
      },
    },
    async ({ organizationId, params, body }, reply) =>
      reply.send(await updateAutoRouter(organizationId, params.id, body)),
  );

  fastify.delete(
    "/api/auto-routing/routers/:id",
    {
      schema: {
        operationId: RouteId.DeleteAutoRouter,
        description:
          "Delete an auto router with its plans and what it learned. Agents, chats and keys set to it stop using it",
        tags: TAGS,
        params: RouterParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ organizationId, params }, reply) => {
      await deleteAutoRouter(organizationId, params.id);
      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/auto-routing/routers/:id/plans",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingPlans,
        description: "List an auto router's fit outcomes, newest first",
        tags: TAGS,
        params: RouterParamsSchema,
        querystring: AutoRoutingPlansQuerySchema,
        response: constructResponseSchema(
          z.array(AutoRoutingPlanSummarySchema),
        ),
      },
    },
    async ({ organizationId, params, query }, reply) => {
      const router = await loadAutoRouter(organizationId, params.id);
      const records = await RoutingPlanModel.findHistory(
        router.id,
        query.limit,
      );
      return reply.send(records.map(toPlanSummary));
    },
  );

  fastify.get(
    "/api/auto-routing/routers/:id/plans/:planId",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingPlan,
        description:
          "Get one auto routing plan with its fitted models and policy",
        tags: TAGS,
        params: RouterParamsSchema.extend({ planId: UuidIdSchema }),
        response: constructResponseSchema(AutoRoutingPlanDetailSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      const router = await loadAutoRouter(organizationId, params.id);
      const record = await RoutingPlanModel.findRecord(
        router.id,
        params.planId,
      );
      if (!record) throw new ApiError(404, "Plan not found");
      return reply.send(toPlanDetail(record));
    },
  );

  fastify.post(
    "/api/auto-routing/routers/:id/replan",
    {
      schema: {
        operationId: RouteId.ReplanAutoRouting,
        description:
          "Fit a new plan for an auto router at its current settings",
        tags: TAGS,
        params: RouterParamsSchema,
        response: constructResponseSchema(AutoRouterChangeResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) =>
      reply.send(await replanAutoRouter(organizationId, params.id)),
  );

  fastify.post(
    "/api/auto-routing/routers/:id/preview",
    {
      bodyLimit: 256 * 1024,
      schema: {
        operationId: RouteId.PreviewAutoRouting,
        description:
          "Score opening text or a request body with its system/tool context and show a fresh choice under the router's current plan, without executing the request or storing a decision",
        tags: TAGS,
        params: RouterParamsSchema,
        body: AutoRoutingPreviewBodySchema,
        response: constructResponseSchema(AutoRoutingPreviewResponseSchema),
      },
    },
    async ({ organizationId, params, body }, reply) =>
      reply.send(
        await previewAutoRouting({
          organizationId,
          routerId: params.id,
          ...body,
        }),
      ),
  );

  fastify.post(
    "/api/auto-routing/routers/:id/simulate",
    {
      schema: {
        operationId: RouteId.SimulateAutoRouting,
        description:
          "Fit a plan for an auto router at a budget, or a budget preset, and a scaled traffic volume without publishing it",
        tags: TAGS,
        params: RouterParamsSchema,
        body: AutoRoutingSimulateBodySchema,
        response: {
          ...constructResponseSchema(AutoRoutingSimulateResponseSchema),
          429: generateErrorResponseSchema("api_rate_limit_error"),
        },
      },
    },
    async ({ organizationId, params, body }, reply) => {
      const router = await loadAutoRouter(organizationId, params.id);
      return reply.send(await simulateFit(router.id, body));
    },
  );

  fastify.get(
    "/api/auto-routing/routers/:id/diagnostics",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingDiagnostics,
        description:
          "Re-solve an auto router's current fit history, at the active plan's scorer version and tiers, at a budget and return per-session estimates and routes, without publishing",
        tags: TAGS,
        params: RouterParamsSchema,
        querystring: AutoRoutingDiagnosticsQuerySchema,
        response: {
          ...constructResponseSchema(AutoRoutingDiagnosticsResponseSchema),
          429: generateErrorResponseSchema("api_rate_limit_error"),
        },
      },
    },
    async ({ organizationId, params, query }, reply) => {
      const router = await loadAutoRouter(organizationId, params.id);
      return reply.send(
        await diagnoseAutoRouting(router, query.budgetUsdPerDay),
      );
    },
  );

  fastify.get(
    "/api/auto-routing/backfill",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingBackfill,
        description:
          "Get the newest historical backfill and what scoring past sessions would take, for the organization's first auto router",
        tags: TAGS,
        response: constructResponseSchema(AutoRoutingBackfillResponseSchema),
      },
    },
    async ({ organizationId }, reply) =>
      reply.send(await describeBackfill(organizationId)),
  );

  fastify.post(
    "/api/auto-routing/backfill/scan",
    {
      schema: {
        operationId: RouteId.ScanAutoRoutingBackfill,
        description:
          "Count the past sessions auto routing could learn from; reads the database only",
        tags: TAGS,
        response: constructResponseSchema(AutoRoutingBackfillResponseSchema),
      },
    },
    async ({ organizationId, user }, reply) => {
      await startBackfillScan(organizationId, humanUserId(user.id));
      return reply.send(await describeBackfill(organizationId));
    },
  );

  fastify.post(
    "/api/auto-routing/backfill/score",
    {
      schema: {
        operationId: RouteId.ScoreAutoRoutingBackfill,
        description:
          "Score a sample of the scanned past sessions with the session scorer, up to a USD ceiling",
        tags: TAGS,
        body: AutoRoutingScoreBackfillBodySchema,
        response: constructResponseSchema(AutoRoutingBackfillResponseSchema),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      await startBackfillScoring(organizationId, humanUserId(user.id), body);
      return reply.send(await describeBackfill(organizationId));
    },
  );

  fastify.delete(
    "/api/auto-routing/backfill",
    {
      schema: {
        operationId: RouteId.CancelAutoRoutingBackfill,
        description: "Cancel the running historical backfill",
        tags: TAGS,
        response: constructResponseSchema(AutoRoutingBackfillResponseSchema),
      },
    },
    async ({ organizationId }, reply) => {
      await cancelBackfill(organizationId);
      return reply.send(await describeBackfill(organizationId));
    },
  );
};

export default autoRoutingRoutes;

/** The acting person, for `started_by`; service accounts have no users row. */
function humanUserId(userId: string): string | null {
  return isServiceAccountUserId(userId) ? null : userId;
}
