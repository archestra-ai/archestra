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
  getAutoRoutingSettings,
  replanAutoRouting,
  toPlanDetail,
  toPlanSummary,
  updateAutoRoutingSettings,
} from "@/auto-routing/settings";
import config from "@/config";
import RoutingPlanModel from "@/models/routing-plan";
import {
  ApiError,
  constructResponseSchema,
  generateErrorResponseSchema,
  UuidIdSchema,
} from "@/types";
import {
  AutoRoutingBackfillResponseSchema,
  AutoRoutingDiagnosticsQuerySchema,
  AutoRoutingDiagnosticsResponseSchema,
  AutoRoutingPlanDetailSchema,
  AutoRoutingPlanSummarySchema,
  AutoRoutingPlansQuerySchema,
  AutoRoutingPreviewBodySchema,
  AutoRoutingPreviewResponseSchema,
  AutoRoutingScoreBackfillBodySchema,
  AutoRoutingSettingsChangeResponseSchema,
  AutoRoutingSettingsResponseSchema,
  AutoRoutingSimulateBodySchema,
  AutoRoutingSimulateResponseSchema,
  UpdateAutoRoutingSettingsBodySchema,
} from "@/types/auto-routing-api";

const TAGS = ["Auto Routing"];

const autoRoutingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // onRequest, so a disabled deployment never parses a body.
  fastify.addHook("onRequest", async () => {
    if (!config.autoRouting.enabled) {
      throw new ApiError(404, "Auto routing is not enabled");
    }
  });

  fastify.get(
    "/api/auto-routing/settings",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingSettings,
        description:
          "Get the organization's auto routing settings and planning status",
        tags: TAGS,
        response: constructResponseSchema(AutoRoutingSettingsResponseSchema),
      },
    },
    async ({ organizationId }, reply) =>
      reply.send(await getAutoRoutingSettings(organizationId)),
  );

  fastify.put(
    "/api/auto-routing/settings",
    {
      schema: {
        operationId: RouteId.UpdateAutoRoutingSettings,
        description:
          "Update auto routing settings and fit a plan on them when auto routing is enabled and configured",
        tags: TAGS,
        body: UpdateAutoRoutingSettingsBodySchema,
        response: constructResponseSchema(
          AutoRoutingSettingsChangeResponseSchema,
        ),
      },
    },
    async ({ organizationId, body }, reply) =>
      reply.send(await updateAutoRoutingSettings(organizationId, body)),
  );

  fastify.get(
    "/api/auto-routing/plans",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingPlans,
        description: "List auto routing fit outcomes, newest first",
        tags: TAGS,
        querystring: AutoRoutingPlansQuerySchema,
        response: constructResponseSchema(
          z.array(AutoRoutingPlanSummarySchema),
        ),
      },
    },
    async ({ organizationId, query }, reply) => {
      const records = await RoutingPlanModel.findHistory(
        organizationId,
        query.limit,
      );
      return reply.send(records.map(toPlanSummary));
    },
  );

  fastify.get(
    "/api/auto-routing/plans/:id",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingPlan,
        description:
          "Get one auto routing plan with its fitted models and policy",
        tags: TAGS,
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(AutoRoutingPlanDetailSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      const record = await RoutingPlanModel.findRecord(
        organizationId,
        params.id,
      );
      if (!record) throw new ApiError(404, "Plan not found");
      return reply.send(toPlanDetail(record));
    },
  );

  fastify.post(
    "/api/auto-routing/replan",
    {
      schema: {
        operationId: RouteId.ReplanAutoRouting,
        description: "Fit a new auto routing plan at the current settings",
        tags: TAGS,
        response: constructResponseSchema(
          AutoRoutingSettingsChangeResponseSchema,
        ),
      },
    },
    async ({ organizationId }, reply) =>
      reply.send(await replanAutoRouting(organizationId)),
  );

  fastify.post(
    "/api/auto-routing/preview",
    {
      schema: {
        operationId: RouteId.PreviewAutoRouting,
        description:
          "Score a first message and show the tier the active plan would pick, without storing anything",
        tags: TAGS,
        body: AutoRoutingPreviewBodySchema,
        response: constructResponseSchema(AutoRoutingPreviewResponseSchema),
      },
    },
    async ({ organizationId, body }, reply) =>
      reply.send(await previewAutoRouting({ organizationId, text: body.text })),
  );

  fastify.post(
    "/api/auto-routing/simulate",
    {
      schema: {
        operationId: RouteId.SimulateAutoRouting,
        description:
          "Fit a plan at a budget and a scaled traffic volume without publishing it",
        tags: TAGS,
        body: AutoRoutingSimulateBodySchema,
        response: {
          ...constructResponseSchema(AutoRoutingSimulateResponseSchema),
          429: generateErrorResponseSchema("api_rate_limit_error"),
        },
      },
    },
    async ({ organizationId, body }, reply) =>
      reply.send(await simulateFit(organizationId, body)),
  );

  fastify.get(
    "/api/auto-routing/diagnostics",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingDiagnostics,
        description:
          "Re-solve the current fit history, at the active plan's scorer version and tiers, at a budget and return per-session estimates and routes, without publishing",
        tags: TAGS,
        querystring: AutoRoutingDiagnosticsQuerySchema,
        response: {
          ...constructResponseSchema(AutoRoutingDiagnosticsResponseSchema),
          429: generateErrorResponseSchema("api_rate_limit_error"),
        },
      },
    },
    async ({ organizationId, query }, reply) =>
      reply.send(
        await diagnoseAutoRouting(organizationId, query.budgetUsdPerDay),
      ),
  );

  fastify.get(
    "/api/auto-routing/backfill",
    {
      schema: {
        operationId: RouteId.GetAutoRoutingBackfill,
        description:
          "Get the newest historical backfill and what scoring past sessions would take",
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
