import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { createInteractionsIndexes } from "@/database/index-maintenance";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import ModelCostBackfillModel from "@/models/model-cost-backfill";
import {
  calculateCacheCost,
  calculateCost,
} from "@/routes/proxy/utils/cost-optimization";
import { beforeEach, describe, expect, test } from "@/test";
import type { Model } from "@/types";
import type { PricedBillingUsage } from "@/utils/billable-usage";
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

    const plain = await row();
    const swapped = await row({ baselineModel: "another-model" });
    const knowledge = await row({
      source: "knowledge:embedding",
      baselineCost: null,
      cacheCost: null,
      cacheSavings: null,
    });
    const unpriced = await row({ cost: null, baselineCost: null });
    const settled = await row();
    await settleUnderEnforcedLimit({ interactionId: settled.id });
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
    expect(started.rowsEstimated).toBe(4);
    await modelCostBackfillService.runNext();

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

    expect(await costsOf(plain.id)).toEqual({
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
    expect(await costsOf(settled.id)).toEqual(UNCHANGED);
    for (const other of untouched) {
      expect((await costsOf(other.id)).cost).toBe(UNCHANGED.cost);
    }

    const done = await modelCostBackfillService.getLatest(model.id);
    expect(done).toMatchObject({
      status: "completed",
      rowsScanned: 4,
      rowsUpdated: 4,
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
      rowsScanned: 4,
      rowsUpdated: 0,
    });
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
    const settled = await row("2026-10-03T16:00:00Z", "18.0000000000");
    await settleUnderEnforcedLimit({ interactionId: settled.id });

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
        { day: "2026-10-03", requests: 1, recordedCost: 0, recomputedCost: 3 },
      ],
      window: {
        requests: 1,
        subscriptionRequests: 0,
        users: 0,
        recordedCost: 0,
        recomputedCost: 3,
        settledRequests: 1,
      },
    });
  });

  test("says why a model's past costs cannot be recomputed", async ({
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
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
async function settleUnderEnforcedLimit(params: { interactionId: string }) {
  await db.insert(schema.interactionBillingTable).values({
    interactionId: params.interactionId,
    fingerprint: "f".repeat(64),
    usage: { mode: "enforce", cost: "9.0000000000" } as PricedBillingUsage,
    billingMode: "metered",
  });
}
