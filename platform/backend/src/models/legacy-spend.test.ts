import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { priceBillingUsage } from "@/services/billable-usage";
import { expect, test } from "@/test";
import type { InsertInteraction } from "@/types/interaction";
import { normalizeAnthropicUsage } from "@/utils/billable-usage";
import { uuidv7 } from "@/utils/uuid";
import EnvironmentModel from "./environment";
import EnvironmentDefaultUserLimitModel from "./environment-default-user-limit";
import InteractionModel from "./interaction";
import InteractionBillingModel from "./interaction-billing";
import LimitModel, { LimitValidationService } from "./limit";
import ModelModel from "./model";
import StatisticsModel from "./statistics";
import UserLimitUsageResetModel from "./user-limit-usage-reset";

async function record(params: {
  agent: { id: string; organizationId: string; environmentId: string | null };
  userId?: string;
  cacheOnly?: boolean;
}): Promise<InsertInteraction> {
  for (const model of ["executor", "advisor"])
    await ModelModel.create({
      externalId: `anthropic/${model}`,
      provider: "anthropic",
      modelId: model,
      customPricePerMillionInput: model === "advisor" ? "5" : "1",
      customPricePerMillionOutput: model === "advisor" ? "25" : "5",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
  const raw = params.cacheOnly
    ? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 2000 }
    : {
        input_tokens: 300,
        output_tokens: 50,
        iterations: [
          { type: "message", input_tokens: 300, output_tokens: 50 },
          {
            type: "advisor_message",
            model: "advisor",
            input_tokens: 100_000,
            output_tokens: 100_000,
          },
        ],
      };
  const usage = normalizeAnthropicUsage(raw, "executor");
  const priced = await priceBillingUsage({
    model: "executor",
    usage,
    provider: "anthropic",
    mode: "enforce",
  });
  return {
    id: uuidv7(),
    profileId: params.agent.id,
    userId: params.userId,
    type: "anthropic:messages",
    model: "executor",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: priced.cost,
    billingMode: "metered",
    billingUsage: priced,
    billingAttribution: {
      organizationId: params.agent.organizationId,
      environmentId: params.agent.environmentId,
      entities: [
        { entityType: "organization", entityId: params.agent.organizationId },
        { entityType: "agent", entityId: params.agent.id },
        ...(params.userId
          ? [{ entityType: "user" as const, entityId: params.userId }]
          : []),
      ],
    },
    request: { model: "executor", messages: [] },
    response: {
      id: "msg_billing",
      model: "executor",
      role: "assistant",
      type: "message",
      content: [],
      usage: raw,
    },
  };
}

import { createInteractionsIndexes } from "@/database/index-maintenance";
import { modelCostBackfillService } from "@/services/model-cost-backfill";
import { drainBackgroundWork } from "@/utils/background-work";

async function plainRecord(
  agent: { id: string; organizationId: string; environmentId: string | null },
  userId: string,
) {
  const template = await record({ agent, userId });
  const billingUsage = await priceBillingUsage({
    model: "executor",
    provider: "anthropic",
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    mode: "enforce",
  });
  return {
    ...template,
    inputTokens: 1_000_000,
    outputTokens: 0,
    cost: billingUsage.cost,
    billingUsage,
  };
}

test("price edits freeze legacy balances beside settled charges, including catalog replay and resets", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const cap = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 5,
    model: null,
    lastCleanup: new Date(),
  });
  const data = await plainRecord(agent, user.id);
  const legacy = {
    ...data,
    id: uuidv7(),
    billingUsage: undefined,
    billingAttribution: undefined,
  };
  await InteractionModel.create(legacy);
  await drainBackgroundWork();
  await InteractionModel.create(data);
  const total = async () =>
    (await LimitModel.getTokenCostTotals([cap.id])).get(cap.id)?.cost;
  const reports = async () =>
    (
      await StatisticsModel.getModelStatistics({
        organizationId: org.id,
        timeframe: "24h",
      })
    ).reduce((s, r) => s + r.cost, 0);
  expect(await total()).toBe(2);
  expect(await reports()).toBe(2);
  await ModelModel.freezeLegacySpendOnStart();
  await ModelModel.freezeLegacySpendOnStart();
  expect(await total()).toBe(2);
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    }),
  ).toBeNull();
  const model = (
    await ModelModel.findByProviderAndModelIds("anthropic", ["executor"])
  ).get("executor");
  expect(model).toBeDefined();
  if (!model) throw new Error("Missing executor model");
  await ModelModel.update(model.id, { customPricePerMillionInput: "10" });
  expect(await total()).toBe(2);
  expect(await reports()).toBe(2);
  expect(
    (await LimitModel.getSpendUsage([cap.id])).get(cap.id)?.estimatedUsage,
  ).toBe(true);
  expect(
    (await InteractionBillingModel.findMany([data.id as string]))[0].usage.cost,
  ).toBe("1.0000000000");
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    }),
  ).toBeNull();
  const priced = (
    await ModelModel.findByProviderAndModelIds("anthropic", ["executor"])
  ).get("executor");
  if (!priced) throw new Error("Missing executor model");
  await createInteractionsIndexes({
    concurrently: false,
    client: {
      query: (text: string, values?: unknown[]) =>
        db.$client.query(text, values),
    },
  });
  await modelCostBackfillService.start({
    model: priced,
    since: new Date(Date.now() - 86400000),
    organizationId: org.id,
    userId: user.id,
  });
  await modelCostBackfillService.runNext();
  expect(await total()).toBe(11);
  expect(await reports()).toBe(20);
  await ModelModel.update(model.id, { customPricePerMillionInput: "20" });
  expect(await total()).toBe(11);
  expect(await reports()).toBe(20);
  await LimitModel.resetLimitsUsage([cap.id]);
  expect(await total()).toBe(0);
  const nextUsage = await priceBillingUsage({
    model: "executor",
    provider: "anthropic",
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    mode: "enforce",
  });
  await InteractionModel.create({
    ...data,
    id: uuidv7(),
    cost: nextUsage.cost,
    billingUsage: nextUsage,
  });
  expect(await total()).toBe(20);
  await ModelModel.update(model.id, { customPricePerMillionInput: "30" });
  expect(await total()).toBe(20);
});

test("price edits snapshot default-user null-cost estimates and preserve recorded costs", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const data = await plainRecord(agent, user.id);
  for (const cost of ["1.0000000000", null]) {
    await InteractionModel.create({
      ...data,
      id: uuidv7(),
      cost,
      billingUsage: undefined,
      billingAttribution: undefined,
    });
  }
  await drainBackgroundWork();
  const usage = async () =>
    (
      await LimitModel.getDefaultUserLimitUsageByUser({
        organizationId: org.id,
        cleanupInterval: "calendar_month",
        models: null,
      })
    ).get(user.id)?.cost;
  await EnvironmentDefaultUserLimitModel.create({
    organizationId: org.id,
    environmentId: null,
    limitValue: 5,
    model: null,
    cleanupInterval: "calendar_month",
  });
  expect(await usage()).toBe(2);
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      userId: user.id,
    }),
  ).toBeNull();
  const model = (
    await ModelModel.findByProviderAndModelIds("anthropic", ["executor"])
  ).get("executor");
  if (!model) throw new Error("Missing executor model");
  await ModelModel.update(model.id, { customPricePerMillionInput: "10" });
  expect(await usage()).toBe(2);
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      userId: user.id,
    }),
  ).toBeNull();
  const stats = await StatisticsModel.getModelStatistics({
    organizationId: org.id,
    timeframe: "24h",
  });
  expect(stats.reduce((s, r) => s + r.cost, 0)).toBe(1);
});

for (const deletion of ["soft", "hard"] as const) {
  test(`freezes environment-only legacy usage after ${deletion} agent deletion without adding global spend`, async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const environment = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Legacy accounting",
    });
    const agent = await makeAgent({
      organizationId: org.id,
      environmentId: environment.id,
    });
    const model = await ModelModel.create({
      externalId: "anthropic/deleted-agent",
      provider: "anthropic",
      modelId: "deleted-agent",
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "1",
      inputModalities: null,
      outputModalities: null,
    });
    const interaction = await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: model.modelId,
      userId: user.id,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cost: null,
    });
    await drainBackgroundWork();
    await db
      .update(schema.interactionsTable)
      .set({ environmentId: environment.id })
      .where(eq(schema.interactionsTable.id, interaction.id));
    if (deletion === "hard")
      await db
        .delete(schema.agentsTable)
        .where(eq(schema.agentsTable.id, agent.id));
    else
      await db
        .update(schema.agentsTable)
        .set({ deletedAt: new Date() })
        .where(eq(schema.agentsTable.id, agent.id));
    const spend = async (environmentId?: string) =>
      (
        await LimitModel.getDefaultUserLimitUsageByUser({
          organizationId: org.id,
          models: null,
          cleanupInterval: "calendar_month",
          environmentId,
        })
      ).get(user.id)?.cost ?? 0;
    expect(await spend()).toBe(0);
    expect(await spend(environment.id)).toBe(1);
    await ModelModel.update(model.id, { customPricePerMillionInput: "10" });
    expect(await spend()).toBe(0);
    expect(await spend(environment.id)).toBe(1);
    expect(
      (await InteractionBillingModel.findMany([interaction.id]))[0].usage,
    ).toMatchObject({ mode: "legacy", legacyDefaultEnvironmentOnly: true });
    await ModelModel.update(model.id, { customPricePerMillionInput: "20" });
    expect(await spend(environment.id)).toBe(1);
  });
}

test("a failed catalog edit rolls back the freeze, and a retry freezes exactly once", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const model = await ModelModel.create({
    externalId: "anthropic/rollback",
    provider: "anthropic",
    modelId: "rollback",
    customPricePerMillionInput: "1",
    customPricePerMillionOutput: "1",
    inputModalities: null,
    outputModalities: null,
  });
  const cap = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 5,
    model: null,
    lastCleanup: new Date(),
  });
  await LimitModel.recordInteractionTokenUsage({
    agentId: agent.id,
    teamIds: [],
    entities: [],
    model: model.modelId,
    inputTokens: 1_000_000,
    outputTokens: 0,
  });
  await expect(
    ModelModel.update(model.id, { customPricePerMillionInput: "invalid" }),
  ).rejects.toThrow();
  expect(
    await db
      .select()
      .from(schema.limitBillingUsageTable)
      .where(eq(schema.limitBillingUsageTable.limitId, cap.id)),
  ).toHaveLength(0);
  await ModelModel.update(model.id, { customPricePerMillionInput: "10" });
  await ModelModel.update(model.id, { customPricePerMillionInput: "20" });
  expect(
    (await LimitModel.getTokenCostTotals([cap.id])).get(cap.id),
  ).toMatchObject({ cost: 1, estimated: true });
  const [frozen] = await db
    .select()
    .from(schema.limitBillingUsageTable)
    .where(eq(schema.limitBillingUsageTable.limitId, cap.id));
  expect(frozen).toMatchObject({
    coveredTokensIn: 1_000_000,
    cost: "1.0000000000",
    incomplete: 1,
  });
});

for (const change of [
  "upsert",
  "bulk",
  "full",
  "registry",
  "delete",
  "deleteAll",
  "orphan",
] as const) {
  test(`${change} preserves the legacy balance at the previous rate`, async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const seed = {
      externalId: "anthropic/synced",
      provider: "anthropic" as const,
      modelId: "synced",
      promptPricePerToken: "0.000001",
      completionPricePerToken: "0.000001",
      inputModalities: null,
      outputModalities: null,
    };
    const model = await ModelModel.create(seed);
    const cap = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 5,
      model: null,
      lastCleanup: new Date(),
    });
    await LimitModel.recordInteractionTokenUsage({
      agentId: agent.id,
      teamIds: [],
      entities: [],
      model: model.modelId,
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const next = { ...seed, promptPricePerToken: "0.00001" };
    if (change === "upsert") await ModelModel.upsert(next);
    if (change === "bulk") await ModelModel.bulkUpsert([next]);
    if (change === "full") await ModelModel.bulkUpsertFull([next]);
    if (change === "registry")
      await ModelModel.applyRegistryCapabilities(model.id, {
        promptPricePerToken: "0.00001",
        completionPricePerToken: "0.00001",
        cacheReadPricePerToken: null,
        cacheWritePricePerToken: null,
        contextLength: null,
        outputLength: null,
        supportsToolCalling: null,
        supportsReasoningEffort: null,
      });
    if (change === "delete")
      await ModelModel.delete("anthropic", model.modelId);
    if (change === "deleteAll") await ModelModel.deleteAll();
    if (change === "orphan") await ModelModel.deleteOrphanedModels();
    expect(
      (await LimitModel.getTokenCostTotals([cap.id])).get(cap.id)?.cost,
    ).toBe(1);
  });
}

test("default snapshots keep microseconds, survive log retention, and honor reset markers", async ({
  makeOrganization,
  makeAgent,
  makeUser,
  makeInteraction,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const model = await ModelModel.create({
    externalId: "anthropic/timestamp",
    provider: "anthropic",
    modelId: "timestamp",
    customPricePerMillionInput: "1",
    customPricePerMillionOutput: "1",
    inputModalities: null,
    outputModalities: null,
  });
  const interaction = await makeInteraction(agent.id, {
    type: "anthropic:messages",
    model: model.modelId,
    userId: user.id,
    inputTokens: 1_000_000,
    outputTokens: 0,
    cost: null,
  });
  await drainBackgroundWork();
  const base = new Date(Date.now() - 60_000).toISOString().replace("Z", "");
  await db
    .update(schema.interactionsTable)
    .set({ createdAt: sql`${base}::timestamp + interval '123 microseconds'` })
    .where(eq(schema.interactionsTable.id, interaction.id));
  await UserLimitUsageResetModel.recordReset({
    organizationId: org.id,
    userId: user.id,
    resetByUserId: user.id,
    resetAt: new Date(`${base}Z`),
  });
  await db
    .update(schema.userLimitUsageResetsTable)
    .set({ resetAt: sql`${base}::timestamp + interval '100 microseconds'` });
  const spend = async () =>
    (
      await LimitModel.getDefaultUserLimitUsageByUser({
        organizationId: org.id,
        models: null,
        cleanupInterval: "calendar_month",
      })
    ).get(user.id)?.cost ?? 0;
  expect(await spend()).toBe(1);
  await ModelModel.update(model.id, { customPricePerMillionInput: "10" });
  expect(await spend()).toBe(1);
  const [receipt] = await db
    .select({
      at: sql<string>`${schema.interactionBillingTable.createdAt}::text`,
    })
    .from(schema.interactionBillingTable)
    .where(eq(schema.interactionBillingTable.interactionId, interaction.id));
  const [log] = await db
    .select({ at: sql<string>`${schema.interactionsTable.createdAt}::text` })
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, interaction.id));
  expect(receipt.at).toBe(log.at);
  await db
    .delete(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, interaction.id));
  expect(await spend()).toBe(1);
  await UserLimitUsageResetModel.recordReset({
    organizationId: org.id,
    userId: user.id,
    resetByUserId: user.id,
  });
  expect(await spend()).toBe(0);
});

test("explicit recompute promotes a default-limit estimate into a recorded cost without repricing again on later edits", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const data = await plainRecord(agent, user.id);
  const log = await InteractionModel.create({
    ...data,
    cost: null,
    billingUsage: undefined,
    billingAttribution: undefined,
  });
  await drainBackgroundWork();
  const models = await ModelModel.findByProviderAndModelIds("anthropic", [
    "executor",
  ]);
  const model = models.get("executor");
  if (!model) throw new Error("Missing executor");
  await ModelModel.freezeLegacySpendOnStart();
  const spend = async () =>
    (
      await LimitModel.getDefaultUserLimitUsageByUser({
        organizationId: org.id,
        models: null,
        cleanupInterval: "calendar_month",
      })
    ).get(user.id);
  expect(await spend()).toMatchObject({ cost: 1, estimated: true });
  expect((await InteractionBillingModel.findMany([log.id]))[0].usage.mode).toBe(
    "legacy",
  );
  expect((await InteractionModel.findById(log.id))?.cost).toBeNull();
  const updated = await ModelModel.update(model.id, {
    customPricePerMillionInput: "10",
  });
  if (!updated) throw new Error("Missing executor");
  expect(await spend()).toMatchObject({ cost: 1, estimated: true });
  await createInteractionsIndexes({
    concurrently: false,
    client: {
      query: (text: string, values?: unknown[]) =>
        db.$client.query(text, values),
    },
  });
  await modelCostBackfillService.start({
    model: updated,
    since: new Date(Date.now() - 86400000),
    organizationId: org.id,
    userId: user.id,
  });
  await modelCostBackfillService.runNext();
  expect(await spend()).toMatchObject({ cost: 10, estimated: false });
  expect((await InteractionBillingModel.findMany([log.id]))[0].usage.mode).toBe(
    "enforce",
  );
  expect((await InteractionModel.findById(log.id))?.cost).toBe("10.0000000000");
  await ModelModel.update(model.id, { customPricePerMillionInput: "20" });
  expect(await spend()).toMatchObject({ cost: 10, estimated: false });
});

for (const mode of ["off", "shadow"] as const) {
  test(`freezes the default's fallback rather than importing an uncharged ${mode} quote`, async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const data = await plainRecord(agent, user.id);
    const log = await InteractionModel.create({
      ...data,
      cost: null,
      billingUsage: undefined,
      billingAttribution: undefined,
    });
    await drainBackgroundWork();
    if (!data.billingUsage) throw new Error("Missing quote");
    await db.insert(schema.interactionBillingTable).values({
      interactionId: log.id,
      fingerprint: "old-quote",
      organizationId: org.id,
      userId: user.id,
      environmentId: null,
      billingTeamId: null,
      billingMode: "metered",
      usage: {
        ...data.billingUsage,
        mode,
        cost: "999.0000000000",
        components: data.billingUsage.components.map((component) => ({
          ...component,
          cost: "999.0000000000",
        })),
      },
    });
    await ModelModel.freezeLegacySpendOnStart();
    const [receipt] = await InteractionBillingModel.findMany([log.id]);
    expect(receipt.usage).toMatchObject({
      mode: "legacy",
      cost: "1.0000000000",
    });
    expect(receipt.entities).toEqual([]);
    const usage = await LimitModel.getDefaultUserLimitUsageByUser({
      organizationId: org.id,
      models: null,
      cleanupInterval: "calendar_month",
    });
    expect(usage.get(user.id)).toMatchObject({ cost: 1, estimated: true });
  });
}

test("snapshots more than one batch exactly once without changing stored report costs", async ({
  makeOrganization,
  makeAgent,
  makeUser,
  makeInteraction,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const model = await ModelModel.create({
    externalId: "anthropic/batched",
    provider: "anthropic",
    modelId: "batched",
    customPricePerMillionInput: "1",
    customPricePerMillionOutput: "1",
    inputModalities: null,
    outputModalities: null,
  });
  const first = await makeInteraction(agent.id, {
    type: "anthropic:messages",
    model: model.modelId,
    userId: user.id,
    inputTokens: 1_000_000,
    outputTokens: 0,
    cost: null,
  });
  const [template] = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, first.id));
  await db
    .insert(schema.interactionsTable)
    .values(Array.from({ length: 500 }, () => ({ ...template, id: uuidv7() })));
  await ModelModel.freezeLegacySpendOnStart();
  await ModelModel.freezeLegacySpendOnStart();
  await ModelModel.update(model.id, { customPricePerMillionInput: "10" });
  const receipts = await db
    .select()
    .from(schema.interactionBillingTable)
    .where(eq(schema.interactionBillingTable.userId, user.id));
  expect(receipts).toHaveLength(501);
  expect(
    receipts.every((receipt) => receipt.usage.cost === "1.0000000000"),
  ).toBe(true);
  const usage = await LimitModel.getDefaultUserLimitUsageByUser({
    organizationId: org.id,
    models: null,
    cleanupInterval: "calendar_month",
  });
  expect(usage.get(user.id)).toMatchObject({ cost: 501, estimated: true });
  expect((await InteractionModel.findById(first.id))?.cost).toBeNull();
});
