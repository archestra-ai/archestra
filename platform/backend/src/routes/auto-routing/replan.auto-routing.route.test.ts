import { activeScorerVersion } from "@/auto-routing/router";
import config from "@/config";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting } from "@/test/auto-routing";
import { seedFitHistory } from "@/test/auto-routing-fit";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

describe("POST /api/auto-routing/replan", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
    config.autoRouting.minSessions = 30;
  });

  const replan = () =>
    ctx.app.inject({ method: "POST", url: "/api/auto-routing/replan" });

  test("fits an active plan at the current settings and leaves other organizations alone", async ({
    makeOrganization,
  }) => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const other = await makeOrganization();
    await configureAutoRouting(other.id);
    await seedFitHistory({
      organizationId: ctx.organizationId,
      modelId: trio[2].id,
      scorerVersionId: (await activeScorerVersion()).id,
      sessions: 40,
    });

    const response = await replan();

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      enabled: true,
      tiers: { smart: { id: trio[2].id } },
      fit: { status: "active" },
    });
    expect(body.plannedGeneration).toBe(body.generation);
    expect(await RoutingPlanModel.findActive(ctx.organizationId)).toMatchObject(
      {
        id: body.fit.planId,
        trigger: "manual",
        generation: body.generation,
      },
    );
    expect((await AutoRoutingSettingsModel.find(other.id))?.generation).toBe(1);
  });

  test("reports a cold start below the session minimum", async () => {
    await configureAutoRouting(ctx.organizationId);

    const response = await replan();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      fit: { status: "cold_start" },
      status: { activePlan: null, coldStart: { sessions: 0, required: 30 } },
    });
  });

  test("does not fit while auto routing is disabled", async () => {
    await configureAutoRouting(ctx.organizationId);
    await AutoRoutingSettingsModel.update(ctx.organizationId, {
      enabled: false,
    });

    const response = await replan();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ fit: null, generation: 3 });
    expect(await RoutingPlanModel.findHistory(ctx.organizationId, 1)).toEqual(
      [],
    );
  });
});
