import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { completeFit, prepareFit } from "@/auto-routing/fit";
import { activeScorerVersion } from "@/auto-routing/router";
import { loadTrio, tiersFingerprint } from "@/auto-routing/tiers";
import config from "@/config";
import db, { schema } from "@/database";
import { AgentModel, ModelModel } from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import { seedFitHistory } from "@/test/auto-routing-fit";
import { autoRoutingDispatcher } from "./auto-routing-dispatch-handler";
import { handleAutoRoutingFit } from "./auto-routing-fit-handler";

describe("auto routing plan fit", () => {
  beforeEach(() => {
    config.autoRouting.enabled = true;
    config.autoRouting.minSessions = 30;
  });

  test("records a cold start below the session minimum", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await seedHistory(org, 29);

    await handleAutoRoutingFit({ organizationId: org.organizationId });

    const [plan] = await plans(org.organizationId);
    expect(plan).toMatchObject({
      status: "cold_start",
      plan: null,
      diagnostics: { sessions: 29, min_sessions: 30 },
    });
    expect(await isDirty(org.organizationId)).toBe(false);
  });

  test("publishes a plan for the current tiers that the router can serve", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await seedHistory(org, 40);

    await handleAutoRoutingFit({ organizationId: org.organizationId });

    const active = await RoutingPlanModel.findActive(org.organizationId);
    expect(active).toMatchObject({ status: "active", trigger: "settings" });
    expect(active?.tiersFingerprint).toEqual(
      tiersFingerprint(await currentTrio(org.organizationId)),
    );
    expect(await isDirty(org.organizationId)).toBe(false);

    await handleAutoRoutingFit({ organizationId: org.organizationId });
    const refit = await RoutingPlanModel.findActive(org.organizationId);
    expect(refit?.id).not.toBe(active?.id);
    expect(refit?.trigger).toBe("nightly");
  });

  test("records a router failure with its code and keeps the organization clean", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await AutoRoutingSettingsModel.update(org.organizationId, {
      budgetUsdPerDay: "0.01",
    });
    await seedHistory(org, 40);

    await handleAutoRoutingFit({ organizationId: org.organizationId });

    const [plan] = await plans(org.organizationId);
    expect(plan.status).toBe("failed");
    expect(plan.error).toMatch(/^ARCHESTRA_ROUTER_INFEASIBLE: /);
    expect(await RoutingPlanModel.findActive(org.organizationId)).toBeNull();
    expect(await isDirty(org.organizationId)).toBe(false);
  });

  test("a settings change during a fit rejects it and the next dispatch re-plans", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await seedHistory(org, 40);
    const inputs = await prepareFit(org.organizationId);
    if (!inputs) throw new Error("organization is not configured");

    await AutoRoutingSettingsModel.update(org.organizationId, {
      budgetUsdPerDay: "30.00",
    });
    const stale = await completeFit(inputs);

    expect(stale).toMatchObject({
      kind: "rejected",
      reason: "stale_generation",
    });
    expect(await isDirty(org.organizationId)).toBe(true);

    await autoRoutingDispatcher.dispatch();
    const [task] = await db
      .select()
      .from(schema.tasksTable)
      .where(
        and(
          eq(schema.tasksTable.taskType, "auto_routing_fit"),
          eq(schema.tasksTable.status, "pending"),
        ),
      );
    expect(task.payload).toEqual({ organizationId: org.organizationId });

    await handleAutoRoutingFit(task.payload);
    const settings = await AutoRoutingSettingsModel.find(org.organizationId);
    expect(await RoutingPlanModel.findActive(org.organizationId)).toMatchObject(
      { generation: settings?.generation, budgetUsdPerDay: "30.00" },
    );
  });
});

// === Helpers ===

type Org = { organizationId: string; smartModelId: string };

async function configuredOrganization(
  makeOrganization: () => Promise<{ id: string }>,
): Promise<Org> {
  const organizationId = (await makeOrganization()).id;
  await AgentModel.getOrgLlmProxy(organizationId);
  const [fast, normal, smart] = [
    await pricedModel("1.00", "5.00"),
    await pricedModel("3.00", "15.00"),
    await pricedModel("15.00", "75.00"),
  ];
  await AutoRoutingSettingsModel.update(organizationId, {
    enabled: true,
    budgetUsdPerDay: "25.00",
    fastModelId: fast.id,
    normalModelId: normal.id,
    smartModelId: smart.id,
  });
  return { organizationId, smartModelId: smart.id };
}

function pricedModel(input: string, output: string) {
  const modelId = `model-${randomUUID()}`;
  return ModelModel.create({
    externalId: `openai/${modelId}`,
    provider: "openai",
    modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    customPricePerMillionInput: input,
    customPricePerMillionOutput: output,
  });
}

async function seedHistory(org: Org, sessions: number) {
  await seedFitHistory({
    organizationId: org.organizationId,
    modelId: org.smartModelId,
    scorerVersionId: (await activeScorerVersion()).id,
    sessions,
  });
}

async function currentTrio(organizationId: string) {
  const settings = await AutoRoutingSettingsModel.find(organizationId);
  if (!settings) throw new Error("organization has no LLM Proxy");
  const loaded = await loadTrio(settings);
  if (loaded.kind !== "ok") throw new Error("trio is not configured");
  return loaded.trio;
}

async function isDirty(organizationId: string): Promise<boolean> {
  const settings = await AutoRoutingSettingsModel.find(organizationId);
  if (!settings) throw new Error("organization has no LLM Proxy");
  return settings.generation > settings.plannedGeneration;
}

function plans(organizationId: string) {
  return db
    .select()
    .from(schema.routingPlansTable)
    .where(eq(schema.routingPlansTable.organizationId, organizationId));
}
