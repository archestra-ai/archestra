import { planFormatVersion } from "@archestra/router-rs";
import { eq } from "drizzle-orm";
import { activeSourceVersion } from "@/auto-routing/signals";
import config from "@/config";
import db, { schema } from "@/database";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting } from "@/test/auto-routing";
import { seedFitHistory } from "@/test/auto-routing-fit";
import { recordQueries } from "@/test/query-counter";
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
      scorerVersionId: (await activeSourceVersion()).id,
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

  test("a re-plan with nothing new keeps the active plan without recording another", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await seedHistory(ctx.organizationId, trio[2].id, 40);
    const first = (await replan()).json();

    const response = await replan();

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.fit).toEqual({ status: "unchanged", planId: first.fit.planId });
    expect(body.generation).toBe(first.generation);
    expect(body.status.activePlan.id).toBe(first.fit.planId);
    expect(
      await RoutingPlanModel.findHistory(ctx.organizationId, 10),
    ).toHaveLength(1);
  });

  test("a re-plan over a plan of an older format fits a new plan", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await seedHistory(ctx.organizationId, trio[2].id, 40);
    const first = (await replan()).json();
    await db
      .update(schema.routingPlansTable)
      .set({ planFormatVersion: planFormatVersion() - 1 })
      .where(eq(schema.routingPlansTable.id, first.fit.planId));

    const response = await replan();

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.fit).toMatchObject({ status: "active" });
    expect(body.fit.planId).not.toBe(first.fit.planId);
  });

  test("a re-plan after new usage fits a new plan", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await seedHistory(ctx.organizationId, trio[2].id, 40);
    const first = (await replan()).json();
    await seedHistory(ctx.organizationId, trio[2].id, 5);

    const response = await replan();

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.fit).toMatchObject({ status: "active" });
    expect(body.fit.planId).not.toBe(first.fit.planId);
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

  test("reports the cold-start progress the fit read without aggregating the history again", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await seedFitHistory({
      organizationId: ctx.organizationId,
      modelId: trio[2].id,
      scorerVersionId: (await activeSourceVersion()).id,
      sessions: 29,
    });

    const { result: response, statements } = await recordQueries(replan);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      fit: { status: "cold_start" },
      status: { coldStart: { sessions: 29, required: 30 } },
    });
    const historyScans = statements.filter((statement) =>
      /having max\("routing_usage"\."created_at"\)/i.test(statement),
    );
    expect(historyScans).toHaveLength(1);
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

async function seedHistory(
  organizationId: string,
  modelId: string,
  sessions: number,
) {
  await seedFitHistory({
    organizationId,
    modelId,
    scorerVersionId: (await activeSourceVersion()).id,
    sessions,
  });
}
