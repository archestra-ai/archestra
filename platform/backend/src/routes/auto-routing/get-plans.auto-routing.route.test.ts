import { randomUUID } from "node:crypto";
import config from "@/config";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import {
  configureAutoRouting,
  plannedDecision,
  publishFittedPlan,
} from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import autoRoutingRoutes from "./auto-routing.routes";

describe("GET /api/auto-routing/plans", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  test("lists the organization's fits newest first with the sessions each routed", async ({
    makeOrganization,
  }) => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const first = await publishFittedPlan({
      organizationId: ctx.organizationId,
      trio,
    });
    const second = await publishFittedPlan({
      organizationId: ctx.organizationId,
      trio,
    });
    for (const _ of [1, 2]) {
      await RoutingDecisionModel.insertOrGet({
        ...plannedDecision({
          organizationId: ctx.organizationId,
          sessionKey: RoutingSessionKeySchema.parse(randomUUID()),
          modelId: trio[0].id,
          scorerVersionId: second.scorerVersionId,
        }),
        planId: second.id,
      });
    }
    const other = await makeOrganization();
    await publishFittedPlan({
      organizationId: other.id,
      trio: await configureAutoRouting(other.id),
    });
    const scorerVersion = (
      await RoutingPlanModel.findRecord(ctx.organizationId, second.id)
    )?.scorerVersion;

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/auto-routing/plans",
    });

    expect(response.statusCode, response.body).toBe(200);
    const plans = response.json();
    expect(plans.map((plan: { id: string }) => plan.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(plans[0]).toEqual({
      id: second.id,
      createdAt: second.createdAt.toISOString(),
      trigger: "manual",
      status: "active",
      generation: 2,
      inputWatermark: second.inputWatermark.toISOString(),
      budgetUsdPerDay: 10000,
      scorerVersion,
      coreVersion: "0.1.0",
      planFormatVersion: 1,
      summary: { expected_spend_usd_per_day: 12.5 },
      diagnostics: { holdout_sessions: 4 },
      error: null,
      decisionCount: 2,
    });
    expect(plans[1]).toMatchObject({ status: "superseded", decisionCount: 0 });
  });

  test("honours the limit", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await publishFittedPlan({ organizationId: ctx.organizationId, trio });
    const newest = await publishFittedPlan({
      organizationId: ctx.organizationId,
      trio,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/auto-routing/plans?limit=1",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().map((plan: { id: string }) => plan.id)).toEqual([
      newest.id,
    ]);
  });
});
