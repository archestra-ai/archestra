import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { completeFit, fitNow, prepareFit } from "@/auto-routing/fit";
import { getAutoRoutingSettings } from "@/auto-routing/settings";
import { activeSourceVersion } from "@/auto-routing/signals";
import { loadTrio, tiersFingerprint } from "@/auto-routing/tiers";
import config from "@/config";
import db, { schema, withDbTransaction } from "@/database";
import { AgentModel, ModelModel } from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import {
  activeFit,
  makeScorerVersion,
  setOrganizationTrio,
} from "@/test/auto-routing";
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

  test("names an unrequested fit by what moved: nothing yet, then a finished backfill", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await AutoRoutingSettingsModel.activateScorerVersion(
      org.organizationId,
      (await activeSourceVersion()).id,
    );
    await db
      .update(schema.agentsTable)
      .set({
        autoRoutingPlannedGeneration: sql`${schema.agentsTable.autoRoutingGeneration}`,
      })
      .where(eq(schema.agentsTable.organizationId, org.organizationId));
    await seedHistory(org, 40);

    await handleAutoRoutingFit({ organizationId: org.organizationId });
    expect(
      (await RoutingPlanModel.findActive(org.organizationId))?.trigger,
    ).toBe("initial");

    const scorerVersionId = (await activeSourceVersion()).id;
    await withDbTransaction(async (tx) => {
      const fitGeneration = await AutoRoutingSettingsModel.bumpGeneration(
        org.organizationId,
        tx,
      );
      await tx.insert(schema.routingBackfillsTable).values({
        organizationId: org.organizationId,
        status: "done",
        phase: "score",
        cutoff: new Date(),
        windowStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        scannedAt: new Date(),
        scorerVersionId,
        maxSessions: 40,
        maxCostUsd: "1",
        fitGeneration,
      });
    });
    await handleAutoRoutingFit({ organizationId: org.organizationId });
    expect(
      (await RoutingPlanModel.findActive(org.organizationId))?.trigger,
    ).toBe("backfill");
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

  test("records tiers with different long-context thresholds as a failed fit", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    const [fast, normal] = await currentTrio(org.organizationId);
    for (const [model, threshold] of [
      [fast, 128_000],
      [normal, 200_000],
    ] as const) {
      await ModelModel.update(model.id, {
        longContextThreshold: threshold,
        longContextPricePerMillionInput: "6",
        longContextPricePerMillionOutput: "22.5",
        longContextPricePerMillionCacheRead: "0.6",
        longContextPricePerMillionCacheWrite: "7.5",
      });
    }
    await seedHistory(org, 40);

    await handleAutoRoutingFit({ organizationId: org.organizationId });

    const [plan] = await plans(org.organizationId);
    expect(plan.status).toBe("failed");
    expect(plan.tiersFingerprint).toMatchObject({
      long_context_thresholds: [128_000, 200_000, null],
    });
    expect(await RoutingPlanModel.findActive(org.organizationId)).toBeNull();
    expect(await isDirty(org.organizationId)).toBe(false);
  });

  test("a new scorer version is activated once and refitted as a scorer change", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    const previous = await makeScorerVersion();
    await AutoRoutingSettingsModel.activateScorerVersion(
      org.organizationId,
      previous.id,
    );
    const before = await AutoRoutingSettingsModel.find(org.organizationId);
    if (!before) throw new Error("organization has no LLM Proxy");
    await RoutingPlanModel.publish(
      activeFit({
        organizationId: org.organizationId,
        scorerVersionId: previous.id,
        generation: before.generation,
        inputWatermark: new Date(Date.now() - 60_000),
      }),
    );
    await seedHistory(org, 40);

    await handleAutoRoutingFit({ organizationId: org.organizationId });

    const running = (await activeSourceVersion()).id;
    expect(await RoutingPlanModel.findActive(org.organizationId)).toMatchObject(
      { trigger: "scorer_change", scorerVersionId: running },
    );
    expect(
      await AutoRoutingSettingsModel.find(org.organizationId),
    ).toMatchObject({
      scorerVersionId: running,
      generation: before.generation + 1,
    });
    expect(await isDirty(org.organizationId)).toBe(false);
  });

  test("a history above the session cap fits a deterministic sample at the full window's volume", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await AutoRoutingSettingsModel.update(org.organizationId, {
      budgetUsdPerDay: "1000.00",
    });
    await seedHistory(org, 200);
    const cap = 60;

    const full = await fittedPlan(org.organizationId);
    const capped = await fittedPlan(org.organizationId, cap);
    const again = await fittedPlan(org.organizationId, cap);

    expect(full.inputs.history.sample).toHaveLength(200);
    expect(capped.inputs.history.sample).toHaveLength(cap);
    expect(capped.inputs.history.volume).toEqual(full.inputs.history.volume);
    expect(capped.summary.sessions_per_day).toBe(full.summary.sessions_per_day);
    expect(capped.summary.tokens_per_day).toBe(full.summary.tokens_per_day);
    expect(
      Math.abs(capped.summary.expected_spend / full.summary.expected_spend - 1),
    ).toBeLessThan(0.05);
    expect(again.plan).toEqual(capped.plan);
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

  test("a dispatcher fit over older usage loses to the inline fit that overlapped it", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await seedHistory(org, 40);
    const dispatched = await prepareFit(org.organizationId);
    if (!dispatched) throw new Error("organization is not configured");

    const inline = (await fitNow(org.organizationId, "settings"))?.fit;
    const late = await completeFit(dispatched);

    expect(late).toMatchObject({
      kind: "rejected",
      reason: "stale_watermark",
      plan: { status: "rejected", error: "stale_watermark" },
    });
    const active = await RoutingPlanModel.findActive(org.organizationId);
    expect(inline).toEqual({ status: "active", planId: active?.id });
    expect(
      (await getAutoRoutingSettings(org.organizationId)).status.lastFitError,
    ).toBeNull();
    expect(await isDirty(org.organizationId)).toBe(false);
  });

  test("an inline fit racing a dispatched one leaves one active plan and nothing due", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await seedHistory(org, 40);
    await AutoRoutingSettingsModel.update(org.organizationId, {
      budgetUsdPerDay: "30.00",
    });
    await autoRoutingDispatcher.dispatch();
    const [task] = await pendingFits(org.organizationId);

    const [inline] = await Promise.all([
      fitNow(org.organizationId, "settings"),
      handleAutoRoutingFit(task.payload),
    ]);

    expect(inline?.fit.status).toBe("active");
    const active = (await plans(org.organizationId)).filter(
      (plan) => plan.status === "active",
    );
    expect(active).toHaveLength(1);
    expect(active[0].budgetUsdPerDay).toBe("30.00");
    expect(await isDirty(org.organizationId)).toBe(false);
  });

  test("concurrent inline fits at one generation share a single fit", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await seedHistory(org, 40);

    const results = await Promise.all(
      Array.from({ length: 3 }, () => fitNow(org.organizationId, "settings")),
    );

    const recorded = await plans(org.organizationId);
    expect(recorded).toHaveLength(1);
    for (const result of results) {
      expect(result?.fit).toEqual({ status: "active", planId: recorded[0].id });
    }
  });

  test("callers at a newer generation than the running fit share one follow-up fit on it", async ({
    makeOrganization,
  }) => {
    const org = await configuredOrganization(makeOrganization);
    await seedHistory(org, 40);

    const first = fitNow(org.organizationId, "settings");
    await AutoRoutingSettingsModel.update(org.organizationId, {
      budgetUsdPerDay: "30.00",
    });
    const results = await Promise.all([
      first,
      fitNow(org.organizationId, "settings"),
      fitNow(org.organizationId, "settings"),
    ]);

    const active = await RoutingPlanModel.findActive(org.organizationId);
    expect(active?.budgetUsdPerDay).toBe("30.00");
    for (const result of results) {
      expect(result?.fit).toEqual({ status: "active", planId: active?.id });
    }
    const accepted = (await plans(org.organizationId)).filter(
      (plan) => plan.status !== "rejected",
    );
    expect(accepted).toHaveLength(1);
    expect(await isDirty(org.organizationId)).toBe(false);
  });
});

// === Helpers ===

const PlanSummarySchema = z
  .object({
    summary: z.object({
      sessions_per_day: z.number(),
      tokens_per_day: z.number(),
      expected_spend: z.number(),
    }),
  })
  .passthrough();

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
  await setOrganizationTrio(organizationId, { fast, normal, smart });
  await AutoRoutingSettingsModel.update(organizationId, {
    enabled: true,
    budgetUsdPerDay: "25.00",
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

/** Prepares and publishes a fit reading at most `maxSessions` sessions; its plan must be active. */
async function fittedPlan(organizationId: string, maxSessions?: number) {
  const inputs = await prepareFit(organizationId, undefined, maxSessions);
  if (!inputs) throw new Error("organization is not configured");
  const published = await completeFit(inputs);
  if (published.kind !== "recorded" || published.plan.status !== "active")
    throw new Error(`fit did not publish an active plan: ${published.kind}`);
  const plan = PlanSummarySchema.parse(published.plan.plan);
  return { inputs, plan, summary: plan.summary };
}

async function seedHistory(org: Org, sessions: number) {
  await seedFitHistory({
    organizationId: org.organizationId,
    modelId: org.smartModelId,
    scorerVersionId: (await activeSourceVersion()).id,
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

function pendingFits(organizationId: string) {
  return db
    .select()
    .from(schema.tasksTable)
    .where(
      and(
        eq(schema.tasksTable.taskType, "auto_routing_fit"),
        eq(schema.tasksTable.status, "pending"),
        sql`${schema.tasksTable.payload}->>'organizationId' = ${organizationId}`,
      ),
    );
}

function plans(organizationId: string) {
  return db
    .select()
    .from(schema.routingPlansTable)
    .where(eq(schema.routingPlansTable.organizationId, organizationId));
}
