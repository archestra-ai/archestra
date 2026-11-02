import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { createInteractionsIndexes } from "@/database/index-maintenance";
import InteractionModel from "@/models/interaction";
import InteractionBillingModel from "@/models/interaction-billing";
import LimitModel from "@/models/limit";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import ModelCostBackfillModel from "@/models/model-cost-backfill";
import { calculateInteractionCosts } from "@/routes/proxy/llm-proxy-helpers";
import {
  calculateCacheCost,
  calculateCost,
} from "@/routes/proxy/utils/cost-optimization";
import { priceBillingUsage } from "@/services/billable-usage";
import { beforeEach, describe, expect, test } from "@/test";
import type { Model } from "@/types";
import { uuidv7 } from "@/utils/uuid";
import { modelCostBackfillService } from "./model-cost-backfill";

const indexOptions = {
  concurrently: false,
  client: {
    query: (text: string, values?: unknown[]) => db.$client.query(text, values),
  },
};

beforeEach(async () => {
  await createInteractionsIndexes(indexOptions);
});

describe("recomputing past costs", () => {
  // The recomputed cost must be what the proxy would record for the same
  // usage today, so the expectations come from the write path's own pricing.
  test("rewrites the model's eligible requests at its current prices and leaves the rest alone", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent();
    const model = await makeAnthropicModel({ input: "3", output: "15" });
    const since = new Date(Date.now() - 2 * DAY_MS);
    const usage = {
      inputTokens: 200_000,
      outputTokens: 30_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 100_000,
      cacheWrite1hTokens: 40_000,
    };
    const row = (overrides: Parameters<typeof makeInteraction>[1] = {}) =>
      makeInteraction(agent.id, {
        type: "anthropic:messages",
        model: model.modelId,
        createdAt: new Date(Date.now() - DAY_MS),
        cost: "9.0000000000",
        baselineCost: "9.0000000000",
        cacheCost: "1.0000000000",
        cacheSavings: "1.0000000000",
        ...usage,
        ...overrides,
      });

    const expectedCost = (await calculateCost(
      model.modelId,
      usage.inputTokens,
      usage.outputTokens,
      "anthropic",
      {
        readTokens: usage.cacheReadTokens,
        writeTokens: usage.cacheWriteTokens,
        write1hTokens: usage.cacheWrite1hTokens,
      },
    )) as number;
    const expectedCache = await calculateCacheCost(
      model.modelId,
      "anthropic",
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.cacheWrite1hTokens,
    );
    const cost = expectedCost.toFixed(10);
    const cacheCost = expectedCache?.cacheCost.toFixed(10);
    const cacheSavings = expectedCache?.cacheSavings.toFixed(10);
    expect(cost).not.toBe("9.0000000000");

    const plain = await row();
    // Total already right, cache split wrong, and no source recorded.
    const cacheOnly = await row({
      cost,
      baselineCost: cost,
      cacheCost: "1.0000000000",
      cacheSavings: "1.0000000000",
    });
    const swapped = await row({ baselineModel: "another-model" });
    const knowledge = await row({
      source: "knowledge:embedding",
      baselineCost: null,
      cacheCost: null,
      cacheSavings: null,
    });
    const unpriced = await row({ cost: null, baselineCost: null });
    const untouched = await Promise.all([
      row({ createdAt: new Date(since.getTime() - DAY_MS) }),
      row({ createdAt: new Date(Date.now() + DAY_MS) }),
      row({ type: "bedrock:converse" }),
      row({ model: "some-other-model" }),
      row({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ]);

    const started = await modelCostBackfillService.start({
      model,
      since,
      organizationId: org.id,
      userId: user.id,
    });
    expect(started.rowsEstimated).toBe(5);
    await modelCostBackfillService.runNext();

    expect(await costsOf(plain.id)).toEqual({
      cost,
      baselineCost: cost,
      cacheCost,
      cacheSavings,
    });
    expect(await costsOf(cacheOnly.id)).toEqual({
      cost,
      baselineCost: cost,
      cacheCost,
      cacheSavings,
    });
    // A swap's baseline was priced as the other model: it keeps that cost.
    expect(await costsOf(swapped.id)).toEqual({
      cost,
      baselineCost: "9.0000000000",
      cacheCost,
      cacheSavings,
    });
    // Knowledge-base rows only ever record `cost`.
    expect(await costsOf(knowledge.id)).toEqual({
      cost,
      baselineCost: null,
      cacheCost: null,
      cacheSavings: null,
    });
    expect((await costsOf(unpriced.id)).cost).toBe(cost);
    for (const other of untouched) {
      expect((await costsOf(other.id)).cost).toBe(UNCHANGED.cost);
    }

    const done = await modelCostBackfillService.getLatest(model.id);
    expect(done).toMatchObject({
      status: "completed",
      rowsScanned: 5,
      rowsUpdated: 5,
    });

    // A second pass at the same prices finds every row already correct.
    await modelCostBackfillService.start({
      model,
      since,
      organizationId: org.id,
      userId: user.id,
    });
    await modelCostBackfillService.runNext();
    expect(await modelCostBackfillService.getLatest(model.id)).toMatchObject({
      status: "completed",
      rowsScanned: 5,
      rowsUpdated: 0,
    });
  });

  test("leaves media requests at the cost their media tariff recorded", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent();
    const model = await ModelModel.create({
      externalId: "openai/gpt-image-backfill",
      provider: "openai",
      modelId: "gpt-image-backfill",
      inputModalities: ["text", "image"],
      outputModalities: ["image"],
      customPricePerMillionInput: "3",
      customPricePerMillionOutput: "15",
    });
    const row = (overrides: Parameters<typeof makeInteraction>[1] = {}) =>
      makeInteraction(agent.id, {
        type: "openai:chatCompletions",
        model: model.modelId,
        createdAt: new Date(Date.now() - DAY_MS),
        cost: "9.0000000000",
        inputTokens: 1034,
        outputTokens: 272,
        ...overrides,
      });
    const chat = await row();
    const images = await row({ type: "openai:images" });
    // Gemini records an image generation under its chat type; the media
    // marker on the response is what sets it apart.
    const marked = await row({
      response: {
        __mediaUsage: { tokensAvailable: true, costAvailable: true },
      } as unknown as NonNullable<
        Parameters<typeof makeInteraction>[1]
      >["response"],
    });

    const started = await modelCostBackfillService.start({
      model,
      since: new Date(Date.now() - 2 * DAY_MS),
      organizationId: org.id,
      userId: user.id,
    });
    expect(started.rowsEstimated).toBe(1);
    await modelCostBackfillService.runNext();

    expect((await costsOf(chat.id)).cost).not.toBe("9.0000000000");
    expect((await costsOf(images.id)).cost).toBe("9.0000000000");
    expect((await costsOf(marked.id)).cost).toBe("9.0000000000");
  });

  test("re-prices settled requests from their receipts and corrects the budgets still holding their charge", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    // A self-hosted model priced by hand, with no cache price yet.
    const model = await ModelModel.create({
      externalId: "vllm/fireworks-backfill",
      provider: "vllm",
      modelId: "fireworks-backfill",
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "2",
    });
    const budget = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 100,
      model: null,
    });
    const settle = async () => {
      const usage = {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 1_000_000,
      };
      const billingUsage = await priceBillingUsage({
        model: model.modelId,
        provider: "vllm",
        usage,
        mode: "enforce",
      });
      const id = uuidv7();
      await InteractionModel.create({
        id,
        profileId: agent.id,
        type: "vllm:chatCompletions",
        model: model.modelId,
        ...usage,
        cost: billingUsage.cost,
        billingMode: "metered",
        billingUsage,
        billingAttribution: {
          organizationId: org.id,
          environmentId: agent.environmentId,
          entities: [
            { entityType: "organization", entityId: org.id },
            { entityType: "agent", entityId: agent.id },
          ],
        },
        request: { model: model.modelId, messages: [] },
        response: {
          id: "chatcmpl-backfill",
          object: "chat.completion",
          created: 1,
          model: model.modelId,
          choices: [],
        },
      });
      return id;
    };
    const spend = async () =>
      (await LimitModel.getSpendUsage([budget.id])).get(budget.id);

    // Cache reads were estimated at half the input rate: 0.001 + 0.002 + 0.5.
    const beforeReset = await settle();
    expect((await costsOf(beforeReset)).cost).toBe("0.5030000000");
    // The budget's window starts over; only the next charge is still in it.
    await LimitModel.resetLimitsUsage([budget.id]);
    const afterReset = await settle();
    expect(await spend()).toMatchObject({ estimatedUsage: true });
    expect((await spend())?.modelUsage[0].cost).toBeCloseTo(0.503, 10);

    const priced = await ModelModel.update(model.id, {
      customPricePerMillionCacheRead: "0.1",
    });
    await modelCostBackfillService.start({
      model: priced ?? model,
      since: new Date(Date.now() - DAY_MS),
      organizationId: org.id,
      userId: user.id,
    });
    await modelCostBackfillService.runNext();

    // 0.001 + 0.002 + 1000000 * 0.1 per million
    for (const id of [beforeReset, afterReset]) {
      expect((await costsOf(id)).cost).toBe("0.1030000000");
      const [receipt] = await InteractionBillingModel.findMany([id]);
      expect(receipt.usage).toMatchObject({
        status: "complete",
        issues: [],
        cost: "0.1030000000",
      });
    }
    // Only the charge made since the reset moves, and it is no longer estimated.
    expect(await spend()).toMatchObject({ estimatedUsage: false });
    expect((await spend())?.modelUsage[0].cost).toBeCloseTo(0.103, 10);
    expect(await modelCostBackfillService.getLatest(model.id)).toMatchObject({
      status: "completed",
      rowsUpdated: 2,
    });
  });

  test("redoes a receipt's price findings across its models, flags budgets only for prices, and leaves invalid token counts as charged", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const makeVllmModel = (modelId: string, cacheless: boolean) =>
      ModelModel.create({
        externalId: `vllm/${modelId}`,
        provider: "vllm",
        modelId,
        inputModalities: ["text"],
        outputModalities: ["text"],
        customPricePerMillionInput: "1",
        customPricePerMillionOutput: "2",
        ...(cacheless
          ? {}
          : {
              customPricePerMillionCacheRead: "0.1",
              customPricePerMillionCacheWrite: "1.25",
            }),
      });
    const executor = await makeVllmModel("router-executor", true);
    const advisor = await makeVllmModel("router-advisor", false);
    const [orgBudget, userBudget] = await Promise.all(
      [
        { entityType: "organization" as const, entityId: org.id },
        { entityType: "user" as const, entityId: user.id },
      ].map((entity) =>
        LimitModel.create({
          ...entity,
          limitType: "token_cost",
          limitValue: 100,
          model: null,
        }),
      ),
    );
    const charge = async (
      billingUsage: Awaited<ReturnType<typeof priceBillingUsage>>,
      entity: { entityType: "organization" | "user"; entityId: string },
    ) => {
      const id = uuidv7();
      await InteractionModel.create({
        id,
        profileId: agent.id,
        type: "vllm:chatCompletions",
        model: billingUsage.components[0].model,
        inputTokens: 1000,
        outputTokens: 1000,
        cost: billingUsage.cost,
        billingMode: "metered",
        billingUsage,
        billingAttribution: {
          organizationId: org.id,
          environmentId: agent.environmentId,
          entities: [entity],
        },
        request: { model: billingUsage.components[0].model, messages: [] },
        response: {
          id: "chatcmpl-findings",
          object: "chat.completion",
          created: 1,
          model: billingUsage.components[0].model,
          choices: [],
        },
      });
      return id;
    };
    const component = (model: string, cacheReadTokens: number) => ({
      model,
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
    });
    const orgEntity = { entityType: "organization" as const, entityId: org.id };

    // The executor's cache read has no price; the advisor's call is priced.
    const mixed = await priceBillingUsage({
      model: executor.modelId,
      provider: "vllm",
      mode: "enforce",
      usage: {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 1_000_000,
        billingUsage: {
          version: 1,
          status: "complete",
          issues: [],
          components: [
            {
              id: "primary",
              kind: "message",
              ...component(executor.modelId, 1_000_000),
            },
            {
              id: "advisor",
              kind: "advisor_message",
              ...component(advisor.modelId, 0),
            },
          ],
        },
      },
    });
    expect(mixed.issues).toEqual(["estimated_cache_price"]);
    const mixedId = await charge(mixed, orgEntity);
    // A stored component whose cache split cannot be priced.
    const priced = await priceBillingUsage({
      model: executor.modelId,
      provider: "vllm",
      mode: "enforce",
      usage: { inputTokens: 1000, outputTokens: 1000 },
    });
    const invalidId = await charge(
      {
        ...priced,
        status: "incomplete",
        issues: ["invalid_token_count"],
        components: [
          {
            ...priced.components[0],
            cacheWriteTokens: 0,
            cacheWrite1hTokens: 5,
          },
        ],
      },
      orgEntity,
    );
    // A stream the client cut short is charged but is no price estimate.
    const cutShort = await priceBillingUsage({
      model: advisor.modelId,
      provider: "vllm",
      mode: "enforce",
      usage: { inputTokens: 1000, outputTokens: 1000 },
    });
    await charge(
      { ...cutShort, status: "incomplete", issues: ["partial_stream"] },
      { entityType: "user", entityId: user.id },
    );

    const spend = async (id: string) =>
      (await LimitModel.getSpendUsage([id])).get(id);
    expect(await spend(orgBudget.id)).toMatchObject({ estimatedUsage: true });
    expect(await spend(userBudget.id)).toMatchObject({ estimatedUsage: false });
    expect((await spend(userBudget.id))?.modelUsage[0].cost).toBeCloseTo(
      0.003,
      10,
    );

    const repriced = await ModelModel.update(executor.id, {
      customPricePerMillionCacheRead: "0.1",
      customPricePerMillionCacheWrite: "1.25",
    });
    await modelCostBackfillService.start({
      model: repriced ?? executor,
      since: new Date(Date.now() - DAY_MS),
      organizationId: org.id,
      userId: user.id,
    });
    await modelCostBackfillService.runNext();
    expect(await modelCostBackfillService.getLatest(executor.id)).toMatchObject(
      { status: "completed" },
    );

    const [mixedAfter, invalidAfter] = await InteractionBillingModel.findMany([
      mixedId,
      invalidId,
    ]).then((rows) =>
      [mixedId, invalidId].map(
        (id) => rows.find((row) => row.interactionId === id)?.usage,
      ),
    );
    // 0.001 + 0.002 + 1,000,000 cache reads at 0.1, plus the advisor's 0.003.
    expect(mixedAfter).toMatchObject({
      status: "complete",
      issues: [],
      cost: "0.1060000000",
    });
    expect(invalidAfter).toMatchObject({
      issues: ["invalid_token_count"],
      cost: priced.cost,
    });
    expect(await spend(orgBudget.id)).toMatchObject({ estimatedUsage: false });
  });

  test("re-prices a request priced from its provider key's list at the custom price", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const model = await ModelModel.create({
      externalId: "openai/gateway-chat",
      provider: "openai",
      modelId: "gateway-chat",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const secret = await makeSecret({ secret: { apiKey: "fixture-key" } });
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
      key.id,
      [
        {
          id: model.id,
          modelId: model.modelId,
          providerPricing: {
            promptPricePerToken: "0.000002",
            completionPricePerToken: "0.000008",
            cacheReadPricePerToken: null,
            cacheWritePricePerToken: null,
          },
        },
      ],
      "openai",
    );
    const billingUsage = await priceBillingUsage({
      model: model.modelId,
      provider: "openai",
      mode: "enforce",
      providerApiKeyId: key.id,
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(billingUsage).toMatchObject({
      cost: "10.0000000000",
      components: [{ prices: { source: "provider" } }],
    });
    const id = uuidv7();
    await InteractionModel.create({
      id,
      profileId: agent.id,
      type: "openai:chatCompletions",
      model: model.modelId,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cost: billingUsage.cost,
      billingMode: "metered",
      billingUsage,
      billingAttribution: {
        organizationId: org.id,
        environmentId: agent.environmentId,
        entities: [{ entityType: "organization", entityId: org.id }],
      },
      request: { model: model.modelId, messages: [] },
      response: {
        id: "chatcmpl-gateway",
        object: "chat.completion",
        created: 1,
        model: model.modelId,
        choices: [],
      },
    });

    const custom = await ModelModel.update(model.id, {
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "4",
    });
    await modelCostBackfillService.start({
      model: custom ?? model,
      since: new Date(Date.now() - DAY_MS),
      organizationId: org.id,
      userId: user.id,
    });
    await modelCostBackfillService.runNext();
    const [receipt] = await InteractionBillingModel.findMany([id]);
    expect(receipt.usage).toMatchObject({
      cost: "5.0000000000",
      components: [{ prices: { source: "custom" } }],
    });
  });

  test("reprices each request at its prompt's price tier, as the proxy does, and the preview totals what it writes", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent();
    const model = await makeAnthropicModel({
      input: "3",
      output: "15",
      longContext: {
        threshold: 200_000,
        input: "6",
        output: "22.5",
        cacheRead: "0.6",
        cacheWrite: "7.5",
      },
    });
    const since = new Date(Date.now() - 2 * DAY_MS);
    const usages = {
      // Prompt 230k: above the threshold.
      long: {
        inputTokens: 150_000,
        outputTokens: 10_000,
        cacheReadTokens: 60_000,
        cacheWriteTokens: 20_000,
        cacheWrite1hTokens: 5_000,
      },
      // Prompt 170k: below it.
      base: {
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheReadTokens: 50_000,
        cacheWriteTokens: 20_000,
        cacheWrite1hTokens: 5_000,
      },
      // Exactly at the threshold: still base.
      boundary: {
        inputTokens: 200_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
      },
    };
    const rows = await Promise.all(
      Object.values(usages).map((usage) =>
        makeInteraction(agent.id, {
          type: "anthropic:messages",
          model: model.modelId,
          createdAt: new Date(Date.now() - DAY_MS),
          ...UNCHANGED,
          ...usage,
        }),
      ),
    );
    const expected = await Promise.all(
      Object.values(usages).map(async (usage) => {
        const costs = await calculateInteractionCosts({
          actualModel: model.modelId,
          usage,
          providerName: "anthropic",
        });
        return {
          cost: costs.actualCost?.toFixed(10),
          baselineCost: costs.actualCost?.toFixed(10),
          cacheCost: costs.cacheCost?.toFixed(10) ?? null,
          cacheSavings: costs.cacheSavings?.toFixed(10) ?? null,
        };
      }),
    );

    const preview = await modelCostBackfillService.getPreview({
      model,
      timeZone: "UTC",
      since,
    });
    await modelCostBackfillService.start({
      model,
      since,
      organizationId: org.id,
      userId: user.id,
    });
    await modelCostBackfillService.runNext();

    const written = await Promise.all(rows.map((row) => costsOf(row.id)));
    expect(written).toEqual(expected);
    const total = written.reduce((sum, row) => sum + Number(row.cost), 0);
    expect(preview.window?.recomputedCost).toBeCloseTo(total, 8);
    expect(
      preview.days.reduce((sum, day) => sum + day.recomputedCost, 0),
    ).toBeCloseTo(total, 8);
  });

  test("a run out of time resumes from its cursor on the next run", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent();
    const model = await makeAnthropicModel({ input: "1", output: "1" });
    const seed = await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: model.modelId,
      inputTokens: 1_000,
      outputTokens: 1_000,
      cost: "5.0000000000",
      createdAt: new Date(Date.now() - DAY_MS),
    });
    // 1,500 rows: more than one batch of 1,000.
    await db.execute(sql`
      insert into interactions
        (profile_id, request, response, type, model, input_tokens, output_tokens, cost, created_at)
      select profile_id, request, response, type, model, input_tokens, output_tokens, cost,
        created_at - make_interval(secs => g)
      from interactions, generate_series(1, 1499) g
      where id = ${seed.id}`);

    await modelCostBackfillService.start({
      model,
      since: null,
      organizationId: org.id,
      userId: user.id,
    });
    await modelCostBackfillService.runNext({ timeBudgetMs: 0 });
    expect(await modelCostBackfillService.getLatest(model.id)).toMatchObject({
      status: "running",
      rowsScanned: 1_000,
      rowsUpdated: 1_000,
    });

    // Released, not left to expire: the next run picks it up at once.
    await modelCostBackfillService.runNext();
    expect(await modelCostBackfillService.getLatest(model.id)).toMatchObject({
      status: "completed",
      rowsScanned: 1_500,
      rowsUpdated: 1_500,
    });
    const [{ stale }] = (
      await db.execute<{ stale: number }>(sql`
        select count(*)::integer as stale from interactions
        where model = ${model.modelId} and cost = 5`)
    ).rows;
    expect(stale).toBe(0);
  });

  test("a worker whose lease was taken over cannot write", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent();
    const model = await makeAnthropicModel({ input: "1", output: "1" });
    await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: model.modelId,
      inputTokens: 1_000,
      outputTokens: 1_000,
      createdAt: new Date(Date.now() - DAY_MS),
    });
    const backfill = await modelCostBackfillService.start({
      model,
      since: null,
      organizationId: org.id,
      userId: user.id,
    });

    // A worker claimed it and died: its lease lapsed a minute ago.
    const stale = await ModelCostBackfillModel.claimNext({
      owner: "dead-worker",
      leaseTtlSeconds: -60,
    });
    expect(stale?.id).toBe(backfill.id);
    await modelCostBackfillService.runNext();
    expect(await modelCostBackfillService.getLatest(model.id)).toMatchObject({
      status: "completed",
      rowsUpdated: 1,
    });

    const staleLease = {
      id: backfill.id,
      epoch: stale?.leaseEpoch ?? 0,
    };
    expect(await ModelCostBackfillModel.release(staleLease)).toBe(false);
    expect(
      await db.transaction((tx) =>
        ModelCostBackfillModel.lockOwned(staleLease, tx),
      ),
    ).toBe(false);
  });

  test("one recompute at a time per model", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const model = await makeAnthropicModel({ input: "1", output: "1" });
    const params = {
      model,
      since: null,
      organizationId: org.id,
      userId: user.id,
    };
    await modelCostBackfillService.start(params);
    await expect(modelCostBackfillService.start(params)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test("nothing starts when one request would cost more than its column holds", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent();
    // $7,500 per million tokens (a typo for $75) on a 200k-token request.
    const model = await makeAnthropicModel({ input: "7500", output: "1" });
    await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: model.modelId,
      inputTokens: 200_000,
      outputTokens: 10,
      cost: "3.0000000000",
      createdAt: new Date(Date.now() - DAY_MS),
    });

    await expect(
      modelCostBackfillService.start({
        model,
        since: null,
        organizationId: org.id,
        userId: user.id,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await modelCostBackfillService.getLatest(model.id)).toBeNull();

    // Cheap in total, but what the cache saved overflows: $0.10 cost against
    // $1,999.90 saved at a $20,000 input price.
    const cached = (await ModelModel.update(
      (
        await makeAnthropicModel({ input: "20000", output: "1" })
      ).id,
      { customPricePerMillionCacheRead: "1" },
    )) as Model;
    await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: cached.modelId,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 100_000,
      cost: "0.1000000000",
      createdAt: new Date(Date.now() - DAY_MS),
    });
    await expect(
      modelCostBackfillService.start({
        model: cached,
        since: null,
        organizationId: org.id,
        userId: user.id,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    // Cheap at base prices; the request is above the long-context threshold.
    const long = await makeAnthropicModel({
      input: "1",
      output: "1",
      longContext: {
        threshold: 100_000,
        input: "7500",
        output: "1",
        cacheRead: "1",
        cacheWrite: "1",
      },
    });
    await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: long.modelId,
      inputTokens: 200_000,
      outputTokens: 10,
      cost: "0.2000000000",
      createdAt: new Date(Date.now() - DAY_MS),
    });
    await expect(
      modelCostBackfillService.start({
        model: long,
        since: null,
        organizationId: org.id,
        userId: user.id,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("rejects a stale eighth-decimal price even when both prices map to the same Number", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const model = await makeAnthropicModel({
      input: "99999999.98999999",
      output: "0",
    });
    await expect(
      modelCostBackfillService.start({
        model,
        since: null,
        organizationId: org.id,
        userId: user.id,
        expectedPrices: {
          input: "99999999.99000000",
          output: "0",
          cacheRead: null,
          cacheWrite: null,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await modelCostBackfillService.getLatest(model.id)).toBeNull();
  });

  test("nothing starts when the prices changed after the caller saved them", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const saved = await makeAnthropicModel({ input: "1", output: "1" });
    const base = {
      since: null,
      organizationId: org.id,
      userId: user.id,
    };

    // The caller saved 2/2, but another edit stored 1/1 after it.
    await expect(
      modelCostBackfillService.start({
        ...base,
        model: saved,
        expectedPrices: {
          input: "2",
          output: "2",
          cacheRead: null,
          cacheWrite: null,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Read before another edit landed: the snapshot would be stale.
    await ModelModel.update(saved.id, { customPricePerMillionInput: "3" });
    await expect(
      modelCostBackfillService.start({ ...base, model: saved }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await modelCostBackfillService.getLatest(saved.id)).toBeNull();

    // A catalog sync changed a synced price the custom ones don't override.
    const beforeSync = (await ModelModel.findById(saved.id)) as Model;
    await ModelModel.bulkUpsert([
      {
        externalId: beforeSync.externalId,
        provider: beforeSync.provider,
        modelId: beforeSync.modelId,
        inputModalities: ["text"],
        outputModalities: ["text"],
        cacheReadPricePerToken: "0.000002",
      },
    ]);
    await expect(
      modelCostBackfillService.start({ ...base, model: beforeSync }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Same prices, written differently, start.
    const current = (await ModelModel.findById(saved.id)) as Model;
    await expect(
      modelCostBackfillService.start({
        ...base,
        model: current,
        expectedPrices: {
          input: "3.000",
          output: "1",
          cacheRead: null,
          cacheWrite: null,
        },
      }),
    ).resolves.toMatchObject({ status: "pending" });
  });
});

describe("previewing a recompute", () => {
  test("prices the model's history per day at unsaved prices and sizes the window", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent();
    const model = await makeAnthropicModel({ input: "3", output: "15" });
    const row = (createdAt: string, cost: string) =>
      makeInteraction(agent.id, {
        type: "anthropic:messages",
        model: model.modelId,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cost,
        createdAt: new Date(createdAt),
        billingMode: "metered",
      });
    // 02:00 UTC on Oct 2 is still Oct 1 in New York.
    await row("2026-10-02T02:00:00Z", "18.0000000000");
    await row("2026-10-03T15:00:00Z", "0.0000000000");
    await row("2026-10-03T16:00:00Z", "18.0000000000");

    const preview = await modelCostBackfillService.getPreview({
      model,
      prices: { input: "1", output: "2", cacheRead: null, cacheWrite: null },
      timeZone: "America/New_York",
      since: new Date("2026-10-03T00:00:00Z"),
    });

    expect(preview).toEqual({
      availability: "available",
      instancePriced: false,
      days: [
        { day: "2026-10-01", requests: 1, recordedCost: 18, recomputedCost: 3 },
        { day: "2026-10-03", requests: 2, recordedCost: 18, recomputedCost: 6 },
      ],
      window: {
        requests: 2,
        subscriptionRequests: 0,
        users: 0,
        recordedCost: 18,
        recomputedCost: 6,
      },
    });

    // Preview uses the same eight-decimal half-up price as persistence.
    const rounded = await modelCostBackfillService.getPreview({
      model,
      prices: {
        input: "1.000000005",
        output: "0",
        cacheRead: null,
        cacheWrite: null,
      },
      timeZone: "UTC",
      since: null,
    });
    expect(rounded.days.map((day) => day.recomputedCost)).toEqual([
      1.00000001, 2.00000002,
    ]);
  });

  test("says why a model's past costs cannot be recomputed", async ({
    makeAgent,
    makeInteraction,
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent();
    const preview = (
      model: Model,
      prices?: { input: string; output: string },
    ) =>
      modelCostBackfillService.getPreview({
        model,
        prices: prices && { ...prices, cacheRead: null, cacheWrite: null },
        timeZone: "UTC",
        since: null,
      });

    const openrouter = await ModelModel.create({
      externalId: "openrouter/anthropic/claude-x",
      provider: "openrouter",
      modelId: "anthropic/claude-x",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    expect((await preview(openrouter)).availability).toBe(
      "provider_reported_cost",
    );
    await expect(
      modelCostBackfillService.start({
        model: openrouter,
        since: null,
        organizationId: org.id,
        userId: user.id,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Priced per key by a LiteLLM gateway: only a custom price can apply.
    const litellm = await ModelModel.create({
      externalId: "openai/team-chat",
      provider: "openai",
      modelId: "team-chat",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const secret = await makeSecret({ secret: { apiKey: "fixture-key" } });
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
      key.id,
      [
        {
          id: litellm.id,
          modelId: litellm.modelId,
          providerPricing: {
            promptPricePerToken: "0.000002",
            completionPricePerToken: "0.000008",
            cacheReadPricePerToken: null,
            cacheWritePricePerToken: null,
          },
        },
      ],
      "openai",
    );
    expect(await preview(litellm)).toMatchObject({
      availability: "needs_custom_price",
      instancePriced: true,
    });
    expect(await preview(litellm, { input: "2", output: "8" })).toMatchObject({
      availability: "available",
      instancePriced: true,
    });
    // Once its requests used the cache, the cache price must be set too: the
    // proxy records no cost for a cache price the key never published.
    // (Checked at start, which reads fresh totals; previews may lag 30s.)
    await makeInteraction(agent.id, {
      type: "openai:chatCompletions",
      model: litellm.modelId,
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadTokens: 5_000,
      createdAt: new Date(Date.now() - DAY_MS),
    });
    // A range after the cached requests needs no cache price.
    const recent = await modelCostBackfillService.getPreview({
      model: litellm,
      prices: { input: "2", output: "8", cacheRead: null, cacheWrite: null },
      timeZone: "UTC",
      since: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(recent.availability).toBe("available");
    const startLitellm = async (prices: Partial<Model>) =>
      modelCostBackfillService.start({
        model: (await ModelModel.update(litellm.id, prices)) as Model,
        since: null,
        organizationId: org.id,
        userId: user.id,
      });
    await expect(
      startLitellm({
        customPricePerMillionInput: "2",
        customPricePerMillionOutput: "8",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      startLitellm({ customPricePerMillionCacheRead: "1" }),
    ).resolves.toMatchObject({ status: "pending" });

    await db.execute(
      sql.raw(`DROP INDEX IF EXISTS "interactions_model_created_at_idx"`),
    );
    const anthropic = await makeAnthropicModel({ input: "1", output: "1" });
    expect((await preview(anthropic)).availability).toBe("index_pending");
    await expect(
      modelCostBackfillService.start({
        model: anthropic,
        since: null,
        organizationId: org.id,
        userId: user.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ===

const DAY_MS = 24 * 60 * 60 * 1000;

const UNCHANGED = {
  cost: "9.0000000000",
  baselineCost: "9.0000000000",
  cacheCost: "1.0000000000",
  cacheSavings: "1.0000000000",
};

let modelCounter = 0;

async function makeAnthropicModel(prices: {
  input: string;
  output: string;
  longContext?: {
    threshold: number;
    input: string;
    output: string;
    cacheRead: string;
    cacheWrite: string;
  };
}): Promise<Model> {
  modelCounter += 1;
  const modelId = `claude-backfill-${modelCounter}`;
  return ModelModel.create({
    externalId: `anthropic/${modelId}`,
    provider: "anthropic",
    modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    customPricePerMillionInput: prices.input,
    customPricePerMillionOutput: prices.output,
    longContextThreshold: prices.longContext?.threshold,
    longContextPricePerMillionInput: prices.longContext?.input,
    longContextPricePerMillionOutput: prices.longContext?.output,
    longContextPricePerMillionCacheRead: prices.longContext?.cacheRead,
    longContextPricePerMillionCacheWrite: prices.longContext?.cacheWrite,
  });
}

async function costsOf(id: string) {
  const [row] = await db
    .select({
      cost: schema.interactionsTable.cost,
      baselineCost: schema.interactionsTable.baselineCost,
      cacheCost: schema.interactionsTable.cacheCost,
      cacheSavings: schema.interactionsTable.cacheSavings,
    })
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, id));
  return row;
}

/** The receipt the proxy writes when an enforced cost limit settles a request. */
