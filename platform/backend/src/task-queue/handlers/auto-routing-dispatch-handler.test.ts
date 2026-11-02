import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { AgentModel } from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import {
  activeFit,
  makeRoutingModel,
  makeScorerVersion,
  plannedDecision,
  setOrganizationTrio,
} from "@/test/auto-routing";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import { autoRoutingDispatcher } from "./auto-routing-dispatch-handler";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("auto routing dispatcher", () => {
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  test("enqueues a fit for an organization changed since its last fit", async ({
    makeOrganization,
  }) => {
    const organizationId = await configuredOrganization(makeOrganization);
    await fitAtCurrentGeneration(organizationId);
    await AutoRoutingSettingsModel.update(organizationId, {
      budgetUsdPerDay: "50.00",
    });

    await autoRoutingDispatcher.dispatch();

    expect(await queuedFits(organizationId)).toBe(1);
  });

  test("enqueues a fit when a fit for a superseded scorer version lost at the current generation", async ({
    makeOrganization,
  }) => {
    const organizationId = await configuredOrganization(makeOrganization);
    const superseded = await makeScorerVersion();
    // The fit ran for `superseded` but read the generation another worker's activation produced.
    await AutoRoutingSettingsModel.activateScorerVersion(
      organizationId,
      (await makeScorerVersion()).id,
    );
    const settings = await AutoRoutingSettingsModel.find(organizationId);
    if (!settings) throw new Error("organization has no LLM Proxy");
    const published = await RoutingPlanModel.publish(
      activeFit({
        organizationId,
        scorerVersionId: superseded.id,
        generation: settings.generation,
        inputWatermark: new Date(),
      }),
    );
    expect(published).toMatchObject({ reason: "stale_scorer_version" });

    await autoRoutingDispatcher.dispatch();

    expect(await queuedFits(organizationId)).toBe(1);
  });

  test("enqueues a fit for an organization never fitted or last fitted over a day ago", async ({
    makeOrganization,
  }) => {
    const unfitted = await configuredOrganization(makeOrganization);
    await fitAtCurrentGeneration(unfitted);
    // Clean by generation, but no outcome on record.
    await db.delete(schema.routingPlansTable);
    const stale = await configuredOrganization(makeOrganization);
    const plan = await fitAtCurrentGeneration(stale);
    await db
      .update(schema.routingPlansTable)
      .set({ createdAt: new Date(Date.now() - DAY_MS - 60_000) })
      .where(eq(schema.routingPlansTable.id, plan.id));

    await autoRoutingDispatcher.dispatch();

    expect(await queuedFits(unfitted)).toBe(1);
    expect(await queuedFits(stale)).toBe(1);
  });

  test("leaves clean, disabled and unconfigured organizations alone", async ({
    makeOrganization,
  }) => {
    const clean = await configuredOrganization(makeOrganization);
    await fitAtCurrentGeneration(clean);
    const disabled = await configuredOrganization(makeOrganization);
    await AutoRoutingSettingsModel.update(disabled, { enabled: false });
    const noBudget = await configuredOrganization(makeOrganization);
    await AutoRoutingSettingsModel.update(noBudget, { budgetUsdPerDay: null });

    await autoRoutingDispatcher.dispatch();

    expect(await queuedFits(clean)).toBe(0);
    expect(await queuedFits(disabled)).toBe(0);
    expect(await queuedFits(noBudget)).toBe(0);
  });

  test("enqueues nothing while the feature is off", async ({
    makeOrganization,
  }) => {
    const organizationId = await configuredOrganization(makeOrganization);
    config.autoRouting.enabled = false;

    await autoRoutingDispatcher.dispatch();

    expect(await queuedFits(organizationId)).toBe(0);
  });

  test("keeps one queued fit per organization across dispatches", async ({
    makeOrganization,
  }) => {
    const organizationId = await configuredOrganization(makeOrganization);

    await autoRoutingDispatcher.dispatch();
    await autoRoutingDispatcher.dispatch();

    expect(await queuedFits(organizationId)).toBe(1);
  });

  test("purges expired routing history at most once a day", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const model = await makeRoutingModel();
    const scorer = await makeScorerVersion();
    // Later than any purge another test triggered in this process.
    const now = new Date(Date.now() + 1_000 * DAY_MS);
    const expired = async () => {
      const { decision } = await RoutingDecisionModel.insertOrGet(
        plannedDecision({
          organizationId,
          sessionKey: RoutingSessionKeySchema.parse(randomUUID()),
          modelId: model.id,
          scorerVersionId: scorer.id,
        }),
      );
      await db
        .update(schema.routingDecisionsTable)
        .set({ createdAt: new Date(now.getTime() - 91 * DAY_MS) })
        .where(eq(schema.routingDecisionsTable.id, decision.id));
    };

    await expired();
    await autoRoutingDispatcher.dispatch(now);
    expect(await decisionCount(organizationId)).toBe(0);

    await expired();
    await autoRoutingDispatcher.dispatch(new Date(now.getTime() + 60_000));
    expect(await decisionCount(organizationId)).toBe(1);

    await autoRoutingDispatcher.dispatch(new Date(now.getTime() + DAY_MS));
    expect(await decisionCount(organizationId)).toBe(0);
  });
});

// === Helpers ===

async function configuredOrganization(
  makeOrganization: () => Promise<{ id: string }>,
): Promise<string> {
  const organizationId = (await makeOrganization()).id;
  await AgentModel.getOrgLlmProxy(organizationId);
  const [fast, normal, smart] = [
    await makeRoutingModel(),
    await makeRoutingModel(),
    await makeRoutingModel(),
  ];
  await setOrganizationTrio(organizationId, { fast, normal, smart });
  await AutoRoutingSettingsModel.update(organizationId, {
    enabled: true,
    budgetUsdPerDay: "25.00",
  });
  return organizationId;
}

/** Records a fit outcome at the current generation, leaving the organization clean. */
async function fitAtCurrentGeneration(organizationId: string) {
  const scorer = await makeScorerVersion();
  await AutoRoutingSettingsModel.activateScorerVersion(
    organizationId,
    scorer.id,
  );
  const settings = await AutoRoutingSettingsModel.find(organizationId);
  if (!settings) throw new Error("organization has no LLM Proxy");
  const result = await RoutingPlanModel.publish(
    activeFit({
      organizationId,
      scorerVersionId: scorer.id,
      generation: settings.generation,
      inputWatermark: new Date(),
    }),
  );
  if (result.kind !== "recorded") throw new Error("fit was not recorded");
  return result.plan;
}

async function queuedFits(organizationId: string): Promise<number> {
  const rows = await db
    .select({ payload: schema.tasksTable.payload })
    .from(schema.tasksTable)
    .where(
      and(
        eq(schema.tasksTable.taskType, "auto_routing_fit"),
        eq(schema.tasksTable.status, "pending"),
      ),
    );
  return rows.filter((row) => row.payload.organizationId === organizationId)
    .length;
}

async function decisionCount(organizationId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.routingDecisionsTable.id })
    .from(schema.routingDecisionsTable)
    .where(eq(schema.routingDecisionsTable.organizationId, organizationId));
  return rows.length;
}
