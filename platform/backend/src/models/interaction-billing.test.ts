import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { priceBillingUsage } from "@/services/billable-usage";
import { expect, test } from "@/test";
import type { InsertInteraction } from "@/types/interaction";
import {
  normalizeAnthropicUsage,
  type PricedBillingUsage,
} from "@/utils/billable-usage";
import { uuidv7 } from "@/utils/uuid";
import EnvironmentModel from "./environment";
import EnvironmentDefaultUserLimitModel from "./environment-default-user-limit";
import InteractionModel from "./interaction";
import InteractionBillingModel from "./interaction-billing";
import LimitModel, { LimitValidationService } from "./limit";
import ModelModel from "./model";
import StatisticsModel from "./statistics";

async function record(params: {
  agent: { id: string; organizationId: string; environmentId: string | null };
  userId?: string;
  mode?: PricedBillingUsage["mode"];
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
    mode: params.mode ?? "enforce",
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

test("settles once across replay, keeps historical rates, and replay after reset cannot charge a new window", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const cap = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 1,
    model: null,
    lastCleanup: new Date(),
  });
  const data = await record({ agent, userId: user.id });
  await InteractionModel.create(data);
  await InteractionModel.create(data);
  expect(
    await InteractionBillingModel.findMany([data.id as string]),
  ).toHaveLength(1);
  expect(
    (await LimitModel.getModelUsageBreakdowns([cap.id]))
      .get(cap.id)
      ?.find((row) => row.model === "advisor")?.cost,
  ).toBe(3);
  const price = await ModelModel.findByProviderAndModelIds("anthropic", [
    "advisor",
  ]);
  await ModelModel.update((price.get("advisor") as { id: string }).id, {
    customPricePerMillionInput: "50",
    customPricePerMillionOutput: "250",
  });
  expect(
    (await LimitModel.getModelUsageBreakdowns([cap.id]))
      .get(cap.id)
      ?.find((row) => row.model === "advisor")?.cost,
  ).toBe(3);
  const violation = await LimitValidationService.checkLimitsBeforeRequest({
    agentId: agent.id,
  });
  expect(violation).not.toBeNull();
  await LimitModel.resetLimitsUsage([cap.id]);
  await InteractionModel.create(data);
  expect(
    (await LimitModel.getModelUsageBreakdowns([cap.id]))
      .get(cap.id)
      ?.every((row) => row.cost === 0),
  ).toBe(true);
  const changed = structuredClone(data);
  if (changed.billingUsage) changed.billingUsage.components[0].inputTokens++;
  await expect(InteractionModel.create(changed)).rejects.toThrow(
    "billing identity",
  );
});

test("a failed interaction write rolls back the receipt and budget updates", async ({
  makeAgent,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const cap = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 1,
    model: null,
  });
  const data = await record({ agent });
  await expect(
    InteractionModel.create({ ...data, cost: "invalid" }),
  ).rejects.toThrow();
  expect(
    await InteractionBillingModel.findMany([data.id as string]),
  ).toHaveLength(0);
  expect(
    (await LimitModel.getModelUsageBreakdowns([cap.id])).get(cap.id),
  ).toHaveLength(0);
  await InteractionModel.create(data);
  expect(
    await InteractionBillingModel.findMany([data.id as string]),
  ).toHaveLength(1);
});

test("cache-only spend survives metadata-only logs, retention and mode changes", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const cap = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 100,
    model: null,
  });
  config.logs.contentMode = "metadata_only";
  const data = await record({ agent, userId: user.id, cacheOnly: true });
  if (data.billingUsage) {
    data.billingUsage.components[0].cacheReadTokens = 20_000_000;
    data.billingUsage.components[0].cost = "2.0000000000";
    data.billingUsage.cost = "2.0000000000";
  }
  await InteractionModel.create(data);
  const rows = (await LimitModel.getModelUsageBreakdowns([cap.id])).get(cap.id);
  expect(rows?.[0].cost).toBe(2);
  expect(
    (await InteractionBillingModel.findMany([data.id as string]))[0].usage.cost,
  ).toBe("2.0000000000");
  // Simulate log retention at the storage boundary; receipts deliberately have no FK.
  await db
    .delete(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, data.id as string));
  config.llmProxy.usageAccountingMode = "off";
  await EnvironmentDefaultUserLimitModel.create({
    organizationId: org.id,
    environmentId: null,
    limitValue: 1,
    model: ["executor"],
    cleanupInterval: "calendar_month",
  });
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      userId: user.id,
    }),
  ).not.toBeNull();
});

test("default model-scoped caps include advisor charges while subscription and team billing spare the caller", async ({
  makeAgent,
  makeOrganization,
  makeUser,
  makeTeam,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  await EnvironmentDefaultUserLimitModel.create({
    organizationId: org.id,
    environmentId: null,
    limitValue: 1,
    model: ["advisor"],
    cleanupInterval: "calendar_month",
  });
  const subscription = await record({ agent, userId: user.id });
  await InteractionModel.create({
    ...subscription,
    billingMode: "subscription",
  });
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      userId: user.id,
    }),
  ).toBeNull();
  const team = await makeTeam(org.id, user.id);
  const teamRecord = structuredClone(subscription);
  teamRecord.id = uuidv7();
  teamRecord.billingTeamId = team.id;
  await InteractionModel.create(teamRecord);
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      userId: user.id,
    }),
  ).toBeNull();
  const personal = structuredClone(subscription);
  personal.id = uuidv7();
  await InteractionModel.create(personal);
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      userId: user.id,
    }),
  ).not.toBeNull();
});

test("mixed shadow and enforced completions preserve uncovered legacy usage, including after reset", async ({
  makeAgent,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const cap = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 100,
    model: null,
  });
  const enforce = await record({ agent });
  const shadow = structuredClone(enforce);
  shadow.id = uuidv7();
  if (shadow.billingUsage) shadow.billingUsage.mode = "shadow";
  await InteractionModel.create(enforce);
  await InteractionModel.create(shadow);
  let rows =
    (await LimitModel.getModelUsageBreakdowns([cap.id])).get(cap.id) ?? [];
  expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(3.0011, 10);
  await LimitModel.resetLimitsUsage([cap.id]);
  const lateShadow = structuredClone(shadow);
  lateShadow.id = uuidv7();
  await InteractionModel.create(lateShadow);
  rows = (await LimitModel.getModelUsageBreakdowns([cap.id])).get(cap.id) ?? [];
  expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(0.00055, 10);
});

test("model reporting allocates costs and tokens without multiplying parent request counts", async ({
  makeAgent,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const aliased = await record({ agent });
  aliased.model = "executor-alias";
  await InteractionModel.create(aliased);
  const stats = await StatisticsModel.getModelStatistics({
    organizationId: org.id,
    timeframe: "24h",
  });
  expect(stats.reduce((sum, row) => sum + row.requests, 0)).toBe(1);
  expect(stats.find((row) => row.model === "advisor")?.cost).toBe(3);
  expect(stats.find((row) => row.model === "advisor")?.inputTokens).toBe(
    100_000,
  );
});

test("encrypted content and changed agent attribution do not change the admitted budget owner", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const environment = await EnvironmentModel.create({
    organizationId: org.id,
    name: "Billing test",
  });
  const agent = await makeAgent({
    organizationId: org.id,
    environmentId: environment.id,
  });
  const cap = await LimitModel.create({
    entityType: "environment",
    entityId: environment.id,
    limitType: "token_cost",
    limitValue: 1,
    model: ["advisor"],
  });
  const data = await record({ agent, userId: user.id });
  data.billingAttribution?.entities.push({
    entityType: "environment",
    entityId: environment.id,
  });
  await db
    .update(schema.agentsTable)
    .set({ environmentId: null })
    .where(eq(schema.agentsTable.id, agent.id));
  const audit = { dek: Buffer.alloc(32, 7), conversationId: uuidv7() };
  const created = await InteractionModel.create(data, audit);
  expect(created.request).toEqual(data.request);
  const [stored] = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, created.id));
  expect(stored.request).not.toEqual(data.request);
  expect(stored.environmentId).toBe(environment.id);
  expect(
    (await LimitModel.getModelUsageBreakdowns([cap.id])).get(cap.id)?.[0].cost,
  ).toBe(3);
  const costs = await StatisticsModel.getCostStatistics({
    timeframe: "24h",
    organizationId: org.id,
    requestingUserId: user.id,
    canReadAllUsers: true,
  });
  expect(costs.models.find((item) => item.model === "advisor")?.cost).toBe(3);
  expect(costs.models.reduce((sum, item) => sum + item.requests, 0)).toBe(1);
});

test("deleting a user mid-request preserves the admitted charge and permits idempotent replay", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const cap = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 10,
    model: null,
  });
  const data = await record({ agent, userId: user.id });
  await db.delete(schema.usersTable).where(eq(schema.usersTable.id, user.id));
  const first = await InteractionModel.create(data);
  const replay = await InteractionModel.create(data);
  expect(first.userId).toBeNull();
  expect(replay.id).toBe(first.id);
  expect((await InteractionBillingModel.findMany([first.id]))[0].userId).toBe(
    user.id,
  );
  expect(
    (await LimitModel.getModelUsageBreakdowns([cap.id]))
      .get(cap.id)
      ?.find((item) => item.model === "advisor")?.cost,
  ).toBe(3);
});
