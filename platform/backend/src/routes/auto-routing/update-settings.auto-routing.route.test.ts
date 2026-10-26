import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activeSourceVersion } from "@/auto-routing/signals";
import config from "@/config";
import db, { schema } from "@/database";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import ModelModel from "@/models/model";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting, makeRoutingModel } from "@/test/auto-routing";
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

  test("stores the trio and budget and records a cold start without history", async () => {
    const [fast, normal, smart] = await Promise.all([
      makeRoutingModel(),
      makeRoutingModel(),
      makeRoutingModel(),
    ]);

    const response = await putSettings({
      enabled: true,
      budgetUsdPerDay: 12.5,
      fastModelId: fast.id,
      normalModelId: normal.id,
      smartModelId: smart.id,
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

  test("a router failure saves the settings and reports the failed fit", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await seedHistory(ctx.organizationId, trio[2].id);

    const response = await putSettings({ budgetUsdPerDay: 0.01 });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.fit).toMatchObject({ status: "failed" });
    expect(body.fit.error).toMatch(/^ARCHESTRA_ROUTER_INFEASIBLE: /);
    expect(body.status.lastFitError).toBe(body.fit.error);
    expect(
      (await AutoRoutingSettingsModel.find(ctx.organizationId))
        ?.budgetUsdPerDay,
    ).toBe("0.01");
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

  test("rejects a tier model that does not exist", async () => {
    await configureAutoRouting(ctx.organizationId);

    const response = await putSettings({ normalModelId: randomUUID() });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "The normal tier model does not exist.",
    );
  });

  test.each([
    {
      label: "without tool calling",
      overrides: { supportsToolCalling: false },
    },
    {
      label: "an embedding model",
      overrides: { embeddingDimensions: 1536 as const, outputModalities: [] },
    },
  ])("rejects a tier model $label", async ({ overrides }) => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const modelId = `unfit-${randomUUID()}`;
    const unfit = await ModelModel.create({
      externalId: `openai/${modelId}`,
      provider: "openai",
      modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
      ...overrides,
    });

    const response = await putSettings({ smartModelId: unfit.id });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      `The smart tier model "openai/${modelId}" is not a tool-capable chat model.`,
    );
    expect(
      (await AutoRoutingSettingsModel.find(ctx.organizationId))?.smartModelId,
    ).toBe(trio[2].id);
  });

  test("enabling needs a complete trio", async () => {
    const fast = await makeRoutingModel();

    const response = await putSettings({
      enabled: true,
      budgetUsdPerDay: 10,
      fastModelId: fast.id,
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

  test("rejects tiers with different long-context thresholds", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
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
    const fast = await withThreshold(128_000);
    const normal = await withThreshold(200_000);

    const response = await putSettings({
      fastModelId: fast.id,
      normalModelId: normal.id,
    });

    expect(response.statusCode).toBe(400);
    expect(
      await AutoRoutingSettingsModel.find(ctx.organizationId),
    ).toMatchObject({ fastModelId: trio[0].id, normalModelId: trio[1].id });

    const shared = await withThreshold(128_000);
    const accepted = await putSettings({
      fastModelId: fast.id,
      normalModelId: shared.id,
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
