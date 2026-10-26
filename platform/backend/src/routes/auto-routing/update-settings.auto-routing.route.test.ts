import { randomUUID } from "node:crypto";
import config from "@/config";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import ModelModel from "@/models/model";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting, makeRoutingModel } from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

describe("PUT /api/auto-routing/settings", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  const putSettings = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/auto-routing/settings",
      payload,
    });

  test("stores the trio and budget and bumps the generation", async () => {
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
      generation: 1,
      plannedGeneration: 0,
    });
    expect(
      await AutoRoutingSettingsModel.find(ctx.organizationId),
    ).toMatchObject({
      enabled: true,
      budgetUsdPerDay: "12.50",
      fastModelId: fast.id,
      normalModelId: normal.id,
      smartModelId: smart.id,
      generation: 1,
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
