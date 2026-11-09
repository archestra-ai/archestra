import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activeSourceVersion } from "@/auto-routing/signals";
import config from "@/config";
import db, { schema } from "@/database";
import AutoRouterModel from "@/models/auto-router";
import ModelModel from "@/models/model";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import {
  autoRouterId,
  configureAutoRouting,
  makeRoutingModel,
  setAutoRoutingEnabled,
  tiersBody,
} from "@/test/auto-routing";
import { seedFitHistory } from "@/test/auto-routing-fit";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

describe("POST and PUT /api/auto-routing/routers", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
    config.autoRouting.minSessions = 30;
  });

  const putRouter = (routerId: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "PUT",
      url: `/api/auto-routing/routers/${routerId}`,
      payload,
    });
  const postRouter = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/auto-routing/routers",
      payload,
    });
  const makeTrio = () =>
    Promise.all([makeRoutingModel(), makeRoutingModel(), makeRoutingModel()]);
  const routerBody = async (
    trio: Awaited<ReturnType<typeof makeTrio>>,
    overrides: Record<string, unknown> = {},
  ) => ({
    name: "auto",
    budgetUsdPerDay: 12.5,
    tiers: await tiersBody(ctx.organizationId, {
      fast: trio[0],
      normal: trio[1],
      smart: trio[2],
    }),
    ...overrides,
  });

  test("creates a router over its tiers, stores the budget and records a cold start without history", async () => {
    await setAutoRoutingEnabled(ctx.organizationId, true);
    const [fast, normal, smart] = await makeTrio();

    const response = await postRouter(
      await routerBody([fast, normal, smart], { name: "auto:support" }),
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      name: "auto:support",
      enabled: true,
      budgetUsdPerDay: 12.5,
      usesPastSessions: false,
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
    expect(await AutoRouterModel.find(body.id)).toMatchObject({
      organizationId: ctx.organizationId,
      name: "auto:support",
      enabled: true,
      budgetUsdPerDay: "12.50",
      fastModelId: fast.id,
      normalModelId: normal.id,
      smartModelId: smart.id,
      generation: body.generation,
    });
  });

  test("a router name is taken once per organization", async () => {
    const trio = await makeTrio();
    const first = await postRouter(await routerBody(trio));
    expect(first.statusCode, first.body).toBe(200);

    const second = await postRouter(await routerBody(trio));

    expect(second.statusCode, second.body).toBe(409);
    expect(await AutoRouterModel.list(ctx.organizationId)).toHaveLength(1);
  });

  test("a new router leaves the organization's other router as it was", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const first = await autoRouterId(ctx.organizationId);
    const before = await AutoRouterModel.find(first);
    await seedHistory(first, trio[2].id);

    const response = await postRouter(
      await routerBody(await makeTrio(), { name: "auto:second" }),
    );

    expect(response.statusCode, response.body).toBe(200);
    const after = await AutoRouterModel.find(first);
    expect(after?.generation).toBe(before?.generation);
    expect(await RoutingPlanModel.findActive(first)).toBeNull();
    expect(
      (await AutoRouterModel.list(ctx.organizationId)).map((r) => r.name),
    ).toEqual(["auto", "auto:second"]);
  });

  test("a budget change fits an active plan on the new budget", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);
    await seedHistory(routerId, trio[2].id);

    const response = await putRouter(routerId, { budgetUsdPerDay: 30 });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.fit).toEqual({ status: "active", planId: expect.any(String) });
    expect(body.status.activePlan.id).toBe(body.fit.planId);
    expect(body.plannedGeneration).toBe(body.generation);
    expect(await RoutingPlanModel.findActive(routerId)).toMatchObject({
      id: body.fit.planId,
      budgetUsdPerDay: "30.00",
      generation: body.generation,
      trigger: "settings",
    });
  });

  test("a preset plans on the budget it resolves, keeping the custom budget for when it is set again", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);
    await seedHistory(routerId, trio[2].id);

    const preset = await putRouter(routerId, { budgetPreset: "balanced" });

    expect(preset.statusCode, preset.body).toBe(200);
    expect(preset.json()).toMatchObject({
      budgetPreset: "balanced",
      budgetUsdPerDay: 50,
      fit: { status: "active" },
    });
    const simulated = await ctx.app.inject({
      method: "POST",
      url: `/api/auto-routing/routers/${routerId}/simulate`,
      payload: { budgetPreset: "balanced", volumeMultiplier: 1 },
    });
    expect(await RoutingPlanModel.findActive(routerId)).toMatchObject({
      budgetUsdPerDay: simulated.json().budgetUsdPerDay.toFixed(2),
      summary: simulated.json().summary,
    });

    const custom = await putRouter(routerId, { budgetUsdPerDay: 30 });

    expect(custom.statusCode, custom.body).toBe(200);
    expect(custom.json()).toMatchObject({
      budgetPreset: null,
      budgetUsdPerDay: 30,
    });
    expect(await RoutingPlanModel.findActive(routerId)).toMatchObject({
      budgetUsdPerDay: "30.00",
    });
  });

  test("a preset creates a router without a budget and is never refused as too low", async () => {
    await setAutoRoutingEnabled(ctx.organizationId, true);
    const trio = await makeTrio();

    const response = await postRouter({
      name: "auto",
      budgetPreset: "cost_efficient",
      tiers: (await routerBody(trio)).tiers,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      enabled: true,
      budgetUsdPerDay: null,
      budgetPreset: "cost_efficient",
      fit: { status: "cold_start" },
    });
    const [coldStart] = await RoutingPlanModel.findHistory(body.id, 1);
    expect(coldStart.plan).toMatchObject({
      status: "cold_start",
      budgetUsdPerDay: null,
    });
    expect((await putRouter(body.id, { budgetPreset: null })).statusCode).toBe(
      400,
    );
  });

  test("creating a router needs a budget or a preset", async () => {
    const trio = await makeTrio();
    const { budgetUsdPerDay: _budget, ...withoutBudget } =
      await routerBody(trio);

    const response = await postRouter(withoutBudget);

    expect(response.statusCode).toBe(400);
    expect(await AutoRouterModel.list(ctx.organizationId)).toEqual([]);
  });

  test("an infeasible budget is refused, keeping the saved budget and the serving plan", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);
    await seedHistory(routerId, trio[2].id);
    const serving = (await putRouter(routerId, { budgetUsdPerDay: 30 })).json();

    const response = await putRouter(routerId, { budgetUsdPerDay: 0.01 });

    expect(response.statusCode, response.body).toBe(400);
    const minimum = /\$(\d+\.\d{2})\/day\.$/.exec(
      response.json().error.message,
    )?.[1];
    expect(minimum).toBeDefined();
    expect(await AutoRouterModel.find(routerId)).toMatchObject({
      budgetUsdPerDay: "30.00",
      generation: serving.generation,
    });
    expect(await RoutingPlanModel.findHistory(routerId, 10)).toEqual([
      expect.objectContaining({
        plan: expect.objectContaining({
          id: serving.fit.planId,
          status: "active",
        }),
      }),
    ]);

    const atMinimum = await putRouter(routerId, {
      budgetUsdPerDay: Number(minimum),
    });
    expect(atMinimum.statusCode, atMinimum.body).toBe(200);
    expect(atMinimum.json().fit).toMatchObject({ status: "active" });
  });

  test("concurrent changes leave one active plan on the latest settings", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);
    await seedHistory(routerId, trio[2].id);

    const responses = await Promise.all(
      [30, 40].map((budgetUsdPerDay) =>
        putRouter(routerId, { budgetUsdPerDay }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        fit: { status: "active" },
        status: { lastFitError: null },
      });
    }
    const settings = await AutoRouterModel.find(routerId);
    const active = await db
      .select()
      .from(schema.routingPlansTable)
      .where(
        and(
          eq(schema.routingPlansTable.routerId, routerId),
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
    const routerId = await autoRouterId(ctx.organizationId);

    const response = await putRouter(routerId, { name: "auto:renamed" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      name: "auto:renamed",
      budgetUsdPerDay: 50,
      tiers: { fast: { id: trio[0].id } },
      // The update, then the fit's first activation of the scorer version.
      generation: 3,
    });
  });

  test("a name taken by another router is refused", async () => {
    await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);
    const second = await postRouter(
      await routerBody(await makeTrio(), { name: "auto:second" }),
    );

    const response = await putRouter(second.json().id, { name: "auto" });

    expect(response.statusCode, response.body).toBe(409);
    expect((await AutoRouterModel.find(routerId))?.name).toBe("auto");
  });

  test.each([
    { budgetUsdPerDay: 0 },
    { budgetUsdPerDay: -5 },
    { budgetUsdPerDay: 0.001 },
  ])("rejects a non-positive budget %o", async (payload) => {
    await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);

    const response = await putRouter(routerId, payload);

    expect(response.statusCode).toBe(400);
    expect((await AutoRouterModel.find(routerId))?.generation).toBe(1);
  });

  test("rejects tier fields in the body", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);

    const response = await putRouter(routerId, { normalModelId: randomUUID() });

    expect(response.statusCode).toBe(400);
    expect((await AutoRouterModel.find(routerId))?.normalModelId).toBe(
      trio[1].id,
    );
  });

  test("creating a router needs a complete trio", async () => {
    const [fast, normal, smart] = await makeTrio();
    const { tiers } = await routerBody([fast, normal, smart]);

    const response = await postRouter({
      name: "auto",
      budgetUsdPerDay: 10,
      tiers: { fast: tiers.fast, normal: tiers.normal },
    });

    expect(response.statusCode).toBe(400);
    expect(await AutoRouterModel.list(ctx.organizationId)).toEqual([]);
  });

  test("leaves other organizations untouched", async ({ makeOrganization }) => {
    const other = await makeOrganization();
    const otherTrio = await configureAutoRouting(other.id);
    const otherRouterId = await autoRouterId(other.id);
    await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);

    const response = await putRouter(routerId, { budgetUsdPerDay: 1 });

    expect(response.statusCode, response.body).toBe(200);
    expect(await AutoRouterModel.find(otherRouterId)).toMatchObject({
      enabled: true,
      budgetUsdPerDay: "50.00",
      smartModelId: otherTrio[2].id,
      generation: 1,
    });
    const foreign = await putRouter(otherRouterId, { budgetUsdPerDay: 2 });
    expect(foreign.statusCode).toBe(404);
  });

  test("a router is refused while its trio has different long-context thresholds", async () => {
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

    const response = await postRouter(
      await routerBody([fast, normal, smart], { budgetUsdPerDay: 10 }),
    );

    expect(response.statusCode).toBe(400);
    expect(await AutoRouterModel.list(ctx.organizationId)).toEqual([]);

    const accepted = await postRouter(
      await routerBody([fast, fast, smart], { budgetUsdPerDay: 10 }),
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
  });
});

async function seedHistory(routerId: string, modelId: string) {
  const router = await AutoRouterModel.find(routerId);
  if (!router) throw new Error("auto router does not exist");
  await seedFitHistory({
    organizationId: router.organizationId,
    routerId,
    modelId,
    scorerVersionId: (await activeSourceVersion()).id,
    sessions: 40,
  });
}
