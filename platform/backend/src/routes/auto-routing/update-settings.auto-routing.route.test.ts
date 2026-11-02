import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activeSourceVersion } from "@/auto-routing/signals";
import config from "@/config";
import db, { schema } from "@/database";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import ModelModel from "@/models/model";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import {
  configureAutoRouting,
  makeRoutingModel,
  setOrganizationTrio,
} from "@/test/auto-routing";
import { seedFitHistory } from "@/test/auto-routing-fit";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

describe("PUT /api/auto-routing/settings", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
    config.autoRouting.minSessions = 30;
  });

  const putSettings = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/auto-routing/settings",
      payload,
    });

  test("enables over the organization trio, stores the budget and records a cold start without history", async () => {
    const [fast, normal, smart] = await Promise.all([
      makeRoutingModel(),
      makeRoutingModel(),
      makeRoutingModel(),
    ]);

    await setOrganizationTrio(ctx.organizationId, { fast, normal, smart });

    const response = await putSettings({
      enabled: true,
      budgetUsdPerDay: 12.5,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      budgetUsdPerDay: 12.5,
      tiers: {
        fast: { id: fast.id },
        normal: { id: normal.id },
        smart: { id: smart.id },
      },
      fit: { status: "cold_start" },
      status: { activePlan: null },
    });
    const body = response.json();
    expect(body.plannedGeneration).toBe(body.generation);
    expect(
      await AutoRoutingSettingsModel.find(ctx.organizationId),
    ).toMatchObject({
      enabled: true,
      budgetUsdPerDay: "12.50",
      fastModelId: fast.id,
      normalModelId: normal.id,
      smartModelId: smart.id,
      generation: body.generation,
    });
  });

  test("a budget change fits an active plan on the new budget", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await seedHistory(ctx.organizationId, trio[2].id);

    const response = await putSettings({ budgetUsdPerDay: 30 });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.fit).toEqual({ status: "active", planId: expect.any(String) });
    expect(body.status.activePlan.id).toBe(body.fit.planId);
    expect(body.plannedGeneration).toBe(body.generation);
    expect(await RoutingPlanModel.findActive(ctx.organizationId)).toMatchObject(
      {
        id: body.fit.planId,
        budgetUsdPerDay: "30.00",
        generation: body.generation,
        trigger: "settings",
      },
    );
  });

  test("an infeasible budget is refused, keeping the saved budget and the serving plan", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await seedHistory(ctx.organizationId, trio[2].id);
    const serving = (await putSettings({ budgetUsdPerDay: 30 })).json();

    const response = await putSettings({ budgetUsdPerDay: 0.01 });

    expect(response.statusCode, response.body).toBe(400);
    const minimum = /\$(\d+\.\d{2})\/day\.$/.exec(
      response.json().error.message,
    )?.[1];
    expect(minimum).toBeDefined();
    expect(
      await AutoRoutingSettingsModel.find(ctx.organizationId),
    ).toMatchObject({
      budgetUsdPerDay: "30.00",
      generation: serving.generation,
    });
    expect(await RoutingPlanModel.findHistory(ctx.organizationId, 10)).toEqual([
      expect.objectContaining({
        plan: expect.objectContaining({
          id: serving.fit.planId,
          status: "active",
        }),
      }),
    ]);

    const atMinimum = await putSettings({ budgetUsdPerDay: Number(minimum) });
    expect(atMinimum.statusCode, atMinimum.body).toBe(200);
    expect(atMinimum.json().fit).toMatchObject({ status: "active" });
  });

  test("concurrent changes leave one active plan on the latest settings", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await seedHistory(ctx.organizationId, trio[2].id);

    const responses = await Promise.all(
      [30, 40].map((budgetUsdPerDay) => putSettings({ budgetUsdPerDay })),
    );

    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        fit: { status: "active" },
        status: { lastFitError: null },
      });
    }
    const settings = await AutoRoutingSettingsModel.find(ctx.organizationId);
    const active = await db
      .select()
      .from(schema.routingPlansTable)
      .where(
        and(
          eq(schema.routingPlansTable.organizationId, ctx.organizationId),
          eq(schema.routingPlansTable.status, "active"),
        ),
      );
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      generation: settings?.generation,
      budgetUsdPerDay: settings?.budgetUsdPerDay,
    });
  });

  test("a partial update keeps the other fields", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);

    const response = await putSettings({ enabled: false });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: false,
      budgetUsdPerDay: 50,
      tiers: { fast: { id: trio[0].id } },
      generation: 2,
      fit: null,
    });
  });

  test.each([
    { budgetUsdPerDay: 0 },
    { budgetUsdPerDay: -5 },
    { budgetUsdPerDay: 0.001 },
  ])("rejects a non-positive budget %o", async (payload) => {
    await configureAutoRouting(ctx.organizationId);

    const response = await putSettings(payload);

    expect(response.statusCode).toBe(400);
    expect(
      (await AutoRoutingSettingsModel.find(ctx.organizationId))?.generation,
    ).toBe(1);
  });

  test("rejects tier fields in the body", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);

    const response = await putSettings({ normalModelId: randomUUID() });

    expect(response.statusCode).toBe(400);
    expect(
      (await AutoRoutingSettingsModel.find(ctx.organizationId))?.normalModelId,
    ).toBe(trio[1].id);
  });

  test("enabling needs a complete trio", async () => {
    const fast = await makeRoutingModel();
    await setOrganizationTrio(ctx.organizationId, { fast });

    const response = await putSettings({
      enabled: true,
      budgetUsdPerDay: 10,
    });

    expect(response.statusCode).toBe(400);
    expect(
      (await AutoRoutingSettingsModel.find(ctx.organizationId))?.enabled,
    ).toBe(false);
  });

  test("leaves other organizations untouched", async ({ makeOrganization }) => {
    const other = await makeOrganization();
    const otherTrio = await configureAutoRouting(other.id);
    await configureAutoRouting(ctx.organizationId);

    const response = await putSettings({
      enabled: false,
      budgetUsdPerDay: 1,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await AutoRoutingSettingsModel.find(other.id)).toMatchObject({
      enabled: true,
      budgetUsdPerDay: "50.00",
      smartModelId: otherTrio[2].id,
      generation: 1,
    });
  });

  test("enabling is refused when the organization trio has different long-context thresholds", async () => {
    const withThreshold = (threshold: number) =>
      ModelModel.create({
        externalId: `openai/long-${randomUUID()}`,
        provider: "openai",
        modelId: `long-${randomUUID()}`,
        inputModalities: ["text"],
        outputModalities: ["text"],
        longContextThreshold: threshold,
        longContextPricePerMillionInput: "6",
        longContextPricePerMillionOutput: "22.5",
        longContextPricePerMillionCacheRead: "0.6",
        longContextPricePerMillionCacheWrite: "7.5",
      });
    const [fast, normal, smart] = [
      await withThreshold(128_000),
      await withThreshold(200_000),
      await withThreshold(128_000),
    ];
    await setOrganizationTrio(ctx.organizationId, { fast, normal, smart });

    const response = await putSettings({
      enabled: true,
      budgetUsdPerDay: 10,
    });

    expect(response.statusCode).toBe(400);
    expect(
      (await AutoRoutingSettingsModel.find(ctx.organizationId))?.enabled,
    ).toBe(false);

    await setOrganizationTrio(ctx.organizationId, { normal: fast });
    const accepted = await putSettings({
      enabled: true,
      budgetUsdPerDay: 10,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });
});

async function seedHistory(organizationId: string, modelId: string) {
  await seedFitHistory({
    organizationId,
    modelId,
    scorerVersionId: (await activeSourceVersion()).id,
    sessions: 40,
  });
}
