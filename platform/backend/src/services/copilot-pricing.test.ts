import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach } from "vitest";
import { tiersFingerprint } from "@/auto-routing/tiers";
import {
  type ModelsDevApiResponse,
  type ModelsDevCost,
  modelsDevClient,
  modelsDevLongContextToColumns,
} from "@/clients/models-dev-client";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import InteractionModel from "@/models/interaction";
import InteractionBillingModel from "@/models/interaction-billing";
import LimitModel from "@/models/limit";
import ModelModel from "@/models/model";
import githubCopilotProxyRoutes from "@/routes/proxy/routes/github-copilot";
import { expect, type TestFixtures, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
import captured from "./copilot-pricing.test-data.json";
import { modelSyncService } from "./model-sync";

// Real Fastify, SDK, catalog sync, migrated PGlite, receipts and limit settlement.
// Only provider HTTP is controlled: these are accounting proofs, not GitHub invoices.
setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: Registers the per-test HTTP boundary.
const server = useMswServer();
// Drain MSW's cloned SSE responses so cancellation can complete on both tees.
const drainResponse = ({ response }: { response: Response }) => {
  void response.arrayBuffer();
};
beforeEach(() => {
  server.events.on("response:mocked", drainResponse);
});
const apps: ReturnType<typeof createFastifyInstance>[] = [];
afterEach(async () => {
  await drainBackgroundWork();
  for (const app of apps.splice(0)) await app.close();
  modelsDevClient.clearFetchCache();
  server.events.removeListener("response:mocked", drainResponse);
});

type Fixtures = Pick<
  TestFixtures,
  | "makeOrganization"
  | "makeAgent"
  | "makeUser"
  | "makeMember"
  | "makeSecret"
  | "makeLlmProviderApiKey"
>;
async function setup(f: Fixtures, syncInitially = true) {
  const org = await f.makeOrganization();
  const user = await f.makeUser();
  await f.makeMember(user.id, org.id);
  const agent = await f.makeAgent({ organizationId: org.id });
  const token = `gho_test_${randomUUID()}`;
  const key = syncInitially
    ? await f.makeLlmProviderApiKey(
        org.id,
        (await f.makeSecret({ secret: { apiKey: token } })).id,
        { provider: "github-copilot", userId: user.id },
      )
    : null;
  const passthrough = await makePassthroughCredential({
    organizationId: org.id,
    ownerId: user.id,
  });
  const cap = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 100,
    model: null,
    lastCleanup: new Date(),
  });
  let catalog: ModelsDevApiResponse = structuredClone(
    captured.catalog,
  ) as ModelsDevApiResponse;
  let catalogAvailable = true;
  let prompt = 1;
  let read = 0;
  let write = 0;
  let upstreamCalls = 0;
  server.use(
    http.get("https://models.dev/api.json", () =>
      catalogAvailable
        ? HttpResponse.json(catalog)
        : new HttpResponse(null, { status: 503 }),
    ),
    http.get("https://api.github.com/copilot_internal/v2/token", () =>
      HttpResponse.json({
        token: "test-copilot-bearer",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      }),
    ),
    http.get("https://api.githubcopilot.com/models", () =>
      HttpResponse.json({
        data: Object.keys(captured.catalog["github-copilot"].models).map(
          (id) => ({
            id,
            capabilities: {
              type: "chat",
              limits: { max_context_window_tokens: 1_000_000 },
            },
            supported_endpoints: ["/chat/completions", "/responses"],
          }),
        ),
      }),
    ),
    http.post(
      "https://api.githubcopilot.com/chat/completions",
      async ({ request }) => {
        const body = (await request.json()) as {
          model: string;
          messages: unknown[];
          stream?: boolean;
        };
        if (!body.messages?.length)
          return HttpResponse.json(
            {
              error: {
                message: "messages must be non-empty",
                type: "api_validation_error",
              },
            },
            { status: 400 },
          );
        upstreamCalls++;
        const usage = {
          prompt_tokens: prompt,
          completion_tokens: 4,
          total_tokens: prompt + 4,
          prompt_tokens_details: {
            cached_tokens: read,
            cache_write_tokens: write,
          },
        };
        const envelope = {
          id: `chatcmpl-${randomUUID()}`,
          object: "chat.completion",
          created: 1,
          model: body.model,
        };
        if (!body.stream)
          return HttpResponse.json({
            ...envelope,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "OK" },
                finish_reason: "stop",
              },
            ],
            usage,
          });
        return new HttpResponse(
          `${[
            {
              ...envelope,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "OK" },
                  finish_reason: null,
                },
              ],
            },
            {
              ...envelope,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage,
            },
          ]
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    ),
    http.post(
      "https://api.githubcopilot.com/responses",
      async ({ request }) => {
        const body = (await request.json()) as {
          model: string;
          input?: string;
          stream?: boolean;
        };
        if (!body.input)
          return HttpResponse.json(
            { error: { message: "input required" } },
            { status: 400 },
          );
        upstreamCalls++;
        const result = {
          id: `resp-${randomUUID()}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: body.model,
          output: [
            {
              id: "msg_test",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "OK", annotations: [] }],
            },
          ],
          usage: {
            input_tokens: prompt,
            output_tokens: 4,
            total_tokens: prompt + 4,
            input_tokens_details: {
              cached_tokens: read,
              cache_write_tokens: write,
            },
          },
        };
        if (!body.stream) return HttpResponse.json(result);
        const events = [
          {
            type: "response.created",
            response: { ...result, status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...result.output[0], content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: "msg_test",
            delta: "OK",
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: result.output[0],
          },
          { type: "response.completed", response: result },
        ];
        return new HttpResponse(
          events
            .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    ),
  );
  const sync = async (forceRefresh = false) => {
    if (!key) throw new Error("This fixture has no stored provider key");
    modelsDevClient.clearFetchCache();
    return modelSyncService.syncModelsForApiKey({
      apiKeyId: key.id,
      provider: "github-copilot",
      apiKeyValue: token,
      forceRefresh,
    });
  };
  if (syncInitially) await sync();
  const app = createFastifyInstance();
  apps.push(app);
  await app.register(githubCopilotProxyRoutes);
  return {
    cap,
    agent,
    sync,
    changeCatalog: (next: ModelsDevApiResponse) => {
      catalog = next;
    },
    setCatalogAvailable: (value: boolean) => {
      catalogAvailable = value;
    },
    catalog,
    calls: () => upstreamCalls,
    async send(
      model: string,
      tokens: number,
      options: {
        read?: number;
        write?: number;
        stream?: boolean;
        responses?: boolean;
      } = {},
    ) {
      prompt = tokens;
      read = options.read ?? 0;
      write = options.write ?? 0;
      const response = await app.inject({
        method: "POST",
        url: `/v1/github-copilot/${agent.id}/${options.responses ? "responses" : "chat/completions"}`,
        headers: {
          authorization: `Bearer ${token}`,
          "x-archestra-virtual-key": passthrough,
        },
        payload: options.responses
          ? {
              model,
              input: "Say OK.",
              max_output_tokens: 4,
              stream: options.stream ?? false,
            }
          : {
              model,
              messages: [{ role: "user", content: "Say OK." }],
              max_tokens: 4,
              stream: options.stream ?? false,
            },
      });
      await drainBackgroundWork();
      return response;
    },
  };
}

const boundaryCases = [
  {
    model: "claude-haiku-5.5",
    threshold: 100_000,
    stream: false,
    responses: false,
  },
  {
    model: "claude-haiku-5.5",
    threshold: 100_000,
    stream: true,
    responses: false,
  },
  { model: "grok-4.7", threshold: 200_000, stream: true, responses: false },
  { model: "gpt-5.6-luna", threshold: 200_000, stream: false, responses: true },
  { model: "gpt-6.1-sol", threshold: 272_000, stream: true, responses: true },
  {
    model: "gpt-6.1-terra",
    threshold: 272_000,
    stream: false,
    responses: true,
  },
];

test.for(
  boundaryCases,
)("imports and settles %j at exact prompt boundaries", async (scenario, {
  makeOrganization,
  makeAgent,
  makeUser,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const c = await setup({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  });
  const catalogModel = c.catalog["github-copilot"].models[scenario.model];
  const cost = catalogModel.cost as ModelsDevCost;
  const tier = cost.tiers?.[0];
  expect(tier?.tier.size).toBe(scenario.threshold);
  let total = 0;
  const read = 500;
  const write = cost.cache_write === undefined ? 0 : 100;
  for (const prompt of [
    scenario.threshold - 1,
    scenario.threshold,
    scenario.threshold + 1,
  ]) {
    const rates = prompt > scenario.threshold ? tier : cost;
    if (!rates) throw new Error("Missing captured tier");
    const expected =
      ((prompt - read - write) * (rates.input ?? 0) +
        read * (rates.cache_read ?? 0) +
        write * (rates.cache_write ?? 0) +
        4 * (rates.output ?? 0)) /
      1_000_000;
    const response = await c.send(scenario.model, prompt, {
      ...scenario,
      read,
      write,
    });
    expect(response.statusCode, response.body).toBe(200);
    const logs = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, c.agent.id));
    const log = logs.find((row) => row.inputTokens === prompt - read - write);
    expect(log?.cost).toBe(expected.toFixed(10));
    expect(log?.cacheReadTokens).toBe(read);
    expect(log?.cacheWriteTokens).toBe(write);
    const [receipt] = await InteractionBillingModel.findMany([log?.id ?? ""]);
    expect(receipt.usage.status).toBe("complete");
    expect(receipt.usage.cost).toBe(expected.toFixed(10));
    expect(Number(receipt.usage.components[0].prices.input)).toBe(rates.input);
    expect(Number(receipt.usage.components[0].prices.output)).toBe(
      rates.output,
    );
    total += expected;
    expect(
      (await LimitModel.getModelUsageBreakdowns([c.cap.id])).get(c.cap.id)?.[0]
        .cost,
    ).toBeCloseTo(total, 10);
  }
  if (total <= 1) return; // Spend limits are whole USD; exercise denial once these small fixtures reach one dollar.
  await LimitModel.patch(c.cap.id, { limitValue: 1 });
  const before = c.calls();
  expect(
    (await c.send(scenario.model, scenario.threshold + 1, scenario)).statusCode,
  ).toBe(402);
  expect(c.calls()).toBe(before);
});

test("sync refresh/removal preserves custom schedules and settled history; replay settles once", async ({
  makeOrganization,
  makeAgent,
  makeUser,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const c = await setup({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  });
  // Every captured model survives parser -> enrichment -> SQL, including the
  // 272K entries that also expose a misleading legacy context_over_200k field.
  for (const model of Object.values(c.catalog["github-copilot"].models)) {
    const saved = await ModelModel.findByProviderAndModelId(
      "github-copilot",
      model.id,
    );
    const tier = model.cost?.tiers?.[0];
    expect(saved?.syncedLongContextThreshold).toBe(tier?.tier.size ?? null);
    const prices = ModelModel.getEffectivePricing(
      saved,
      model.id,
      "github-copilot",
      (tier?.tier.size ?? 300_000) + 1,
    );
    expect(Number(prices.pricePerMillionInput)).toBe(
      tier?.input ?? model.cost?.input,
    );
    expect(Number(prices.pricePerMillionOutput)).toBe(
      tier?.output ?? model.cost?.output,
    );
  }
  const noTier = c.catalog["github-copilot"].models["gpt-5-mini"].cost;
  expect((await c.send("gpt-5-mini", 300_001)).statusCode).toBe(200);
  const [ordinaryLog] = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.model, "gpt-5-mini"));
  expect(ordinaryLog.cost).toBe(
    (
      (300_001 * (noTier?.input ?? 0) + 4 * (noTier?.output ?? 0)) /
      1e6
    ).toFixed(10),
  );
  const id = "claude-haiku-5.5";
  const row = await ModelModel.findByProviderAndModelId("github-copilot", id);
  if (!row) throw new Error("Missing synced model");
  expect(row.syncedLongContextThreshold).toBe(100_000);
  expect(tiersFingerprint([row, row, row]).long_context_threshold).toBe(
    100_000,
  );
  expect(tiersFingerprint([row, row, row]).tiers[0].long?.input).toBe(0.5);
  expect(Number(row.syncedLongContextCacheWritePricePerToken) * 1e6).toBe(
    0.625,
  );
  expect(
    (await c.send(id, 100_001, { read: 500, write: 100 })).statusCode,
  ).toBe(200);
  const [original] = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.model, id));
  const [receipt] = await InteractionBillingModel.findMany([original.id]);
  const counters = await db.select().from(schema.limitBillingUsageTable);
  const legacyCounters = await db.select().from(schema.limitModelUsageTable);
  await ModelModel.update(row.id, {
    customPricePerMillionInput: "0.03",
    customPricePerMillionOutput: "0.07",
  });
  await c.sync();
  let updated = await ModelModel.findById(row.id);
  expect(updated?.customPricePerMillionInput).toBe("0.03");
  let prices = ModelModel.getEffectivePricing(
    updated,
    id,
    "github-copilot",
    100_001,
  );
  expect(Number(prices.pricePerMillionInput)).toBe(0.03);
  expect(Number(prices.pricePerMillionOutput)).toBe(0.07);
  expect(Number(prices.pricePerMillionCacheRead)).toBe(0.05);
  await ModelModel.update(row.id, {
    customPricePerMillionInput: null,
    customPricePerMillionOutput: null,
    customPricePerMillionCacheRead: "0.02",
    customPricePerMillionCacheWrite: "0.04",
  });
  await c.sync();
  updated = await ModelModel.findById(row.id);
  prices = ModelModel.getEffectivePricing(
    updated,
    id,
    "github-copilot",
    100_001,
  );
  expect(Number(prices.pricePerMillionInput)).toBe(0.5);
  expect(Number(prices.pricePerMillionCacheRead)).toBe(0.02);
  expect(Number(prices.pricePerMillionCacheWrite)).toBe(0.04);
  await ModelModel.update(row.id, {
    longContextThreshold: 150_000,
    longContextPricePerMillionInput: "2",
    longContextPricePerMillionOutput: "3",
    longContextPricePerMillionCacheRead: "0.2",
    longContextPricePerMillionCacheWrite: "2.5",
  });
  await c.sync();
  updated = await ModelModel.findById(row.id);
  expect(
    Number(
      ModelModel.getEffectivePricing(updated, id, "github-copilot", 120_000)
        .pricePerMillionInput,
    ),
  ).toBe(0.1);
  expect(
    Number(
      ModelModel.getEffectivePricing(updated, id, "github-copilot", 150_001)
        .pricePerMillionInput,
    ),
  ).toBe(2);
  expect(
    ModelModel.getEffectivePricing(updated, id, "github-copilot", 150_001)
      .source,
  ).toBe("custom");
  const next = structuredClone(c.catalog);
  const nextCost = next["github-copilot"].models[id].cost;
  if (!nextCost?.tiers?.[0]) throw new Error("Missing captured tier");
  nextCost.tiers[0].input = 0.7;
  c.changeCatalog(next);
  await c.sync();
  expect(
    Number(
      (await ModelModel.findById(row.id))?.syncedLongContextPromptPricePerToken,
    ) * 1e6,
  ).toBe(0.7);
  c.setCatalogAvailable(false);
  await expect(c.sync()).rejects.toThrow(
    "Copilot pricing catalog is unavailable",
  );
  expect((await ModelModel.findById(row.id))?.syncedLongContextThreshold).toBe(
    100_000,
  );
  c.setCatalogAvailable(true);
  delete nextCost.tiers;
  c.changeCatalog(next);
  await c.sync();
  updated = await ModelModel.findById(row.id);
  expect(updated?.syncedLongContextThreshold).toBeNull();
  expect(updated?.longContextThreshold).toBe(150_000);
  c.changeCatalog(c.catalog);
  await c.sync();
  await ModelModel.update(row.id, {
    customPricePerMillionCacheRead: null,
    customPricePerMillionCacheWrite: null,
    longContextThreshold: null,
    longContextPricePerMillionInput: null,
    longContextPricePerMillionOutput: null,
    longContextPricePerMillionCacheRead: null,
    longContextPricePerMillionCacheWrite: null,
  });
  updated = await ModelModel.findById(row.id);
  expect(
    Number(
      ModelModel.getEffectivePricing(updated, id, "github-copilot", 100_001)
        .pricePerMillionInput,
    ),
  ).toBe(0.5);
  await ModelModel.update(row.id, {
    customPricePerMillionInput: "7",
    customPricePerMillionOutput: "8",
  });
  await c.sync(true); // Explicit full refresh retains its existing reset contract.
  expect(
    (await ModelModel.findById(row.id))?.customPricePerMillionInput,
  ).toBeNull();
  expect(await InteractionBillingModel.findMany([original.id])).toEqual([
    receipt,
  ]);
  expect(await db.select().from(schema.limitBillingUsageTable)).toEqual(
    counters,
  );
  expect(await db.select().from(schema.limitModelUsageTable)).toEqual(
    legacyCounters,
  );
  expect(
    (
      await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.id, original.id))
    )[0].cost,
  ).toBe(original.cost);
  await InteractionModel.create({
    ...original,
    billingUsage: receipt.usage,
    billingAttribution: {
      organizationId: c.agent.organizationId,
      environmentId: c.agent.environmentId,
      entities: receipt.entities ?? [],
    },
  });
  expect(await db.select().from(schema.limitBillingUsageTable)).toEqual(
    counters,
  );
});

test("explicit boundaries outrank legacy metadata, absent rates stay unknown, and unsupported tiers fail visibly", () => {
  expect(
    modelsDevLongContextToColumns({
      input: 1,
      output: 2,
      context_over_200k: { input: 4, output: 6 },
      tiers: [{ input: 2, output: 3, tier: { type: "context", size: 272000 } }],
    }),
  ).toMatchObject({
    syncedLongContextThreshold: 272000,
    syncedLongContextPromptPricePerToken: "0.000002",
    syncedLongContextCacheReadPricePerToken: null,
  });
  expect(
    modelsDevLongContextToColumns({
      context_over_200k: { input: 2, output: 3 },
    }).syncedLongContextThreshold,
  ).toBe(200000);
  expect(
    modelsDevLongContextToColumns({
      tiers: [],
      context_over_200k: { input: 2, output: 3 },
    }).syncedLongContextThreshold,
  ).toBeNull();
  expect(() =>
    modelsDevLongContextToColumns({
      tiers: [
        { tier: { type: "context", size: 100 }, input: 1, output: 2 },
        { tier: { type: "context", size: 200 }, input: 2, output: 3 },
      ],
    }),
  ).toThrow("Multiple Copilot");
  expect(() =>
    modelsDevLongContextToColumns({
      tiers: [{ tier: { type: "context", size: 100 }, input: -1, output: 2 }],
    }),
  ).toThrow();
});

test("custom prices win in actual proxy receipts without importing a surcharge", async ({
  makeOrganization,
  makeAgent,
  makeUser,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const c = await setup({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  });
  const model = "claude-haiku-5.5";
  const row = await ModelModel.findByProviderAndModelId(
    "github-copilot",
    model,
  );
  if (!row) throw new Error("Missing synced model");
  const verify = async (
    prompt: number,
    rates: [number, number, number, number],
  ) => {
    expect(
      (await c.send(model, prompt, { read: 500, write: 100 })).statusCode,
    ).toBe(200);
    const logs = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, c.agent.id));
    const log = logs.find((item) => item.inputTokens === prompt - 600);
    const expected =
      ((prompt - 600) * rates[0] +
        4 * rates[1] +
        500 * rates[2] +
        100 * rates[3]) /
      1e6;
    expect(log?.cost).toBe(expected.toFixed(10));
    const [receipt] = await InteractionBillingModel.findMany([log?.id ?? ""]);
    expect(receipt.usage.cost).toBe(expected.toFixed(10));
  };
  await ModelModel.update(row.id, {
    customPricePerMillionInput: "0.03",
    customPricePerMillionOutput: "0.07",
  });
  await verify(100_001, [0.03, 0.07, 0.05, 0.625]);
  await ModelModel.update(row.id, {
    customPricePerMillionInput: null,
    customPricePerMillionOutput: null,
    customPricePerMillionCacheRead: "0.02",
    customPricePerMillionCacheWrite: "0.04",
  });
  await verify(100_002, [0.5, 2.5, 0.02, 0.04]);
  await ModelModel.update(row.id, {
    longContextThreshold: 150_000,
    longContextPricePerMillionInput: "2",
    longContextPricePerMillionOutput: "3",
    longContextPricePerMillionCacheRead: "0.2",
    longContextPricePerMillionCacheWrite: "2.5",
  });
  await verify(120_000, [0.1, 0.5, 0.02, 0.04]);
  await verify(150_001, [2, 3, 0.2, 2.5]);
});

test("passthrough discovery and registry refresh price already-known Copilot models without stored keys", async ({
  makeOrganization,
  makeAgent,
  makeUser,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const c = await setup(
    {
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    },
    false,
  );
  const modelId = "claude-haiku-5.5";
  expect(
    await ModelModel.findByProviderAndModelId("github-copilot", modelId),
  ).toBeNull();
  expect(
    (await c.send(modelId, 100_001, { read: 500, write: 100 })).statusCode,
  ).toBe(200);
  const row = await ModelModel.findByProviderAndModelId(
    "github-copilot",
    modelId,
  );
  if (!row) throw new Error("Missing discovered model");
  expect(row.discoveredViaLlmProxy).toBe(true);
  expect(row.syncedLongContextThreshold).toBe(100_000);
  const [original] = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.profileId, c.agent.id));
  expect(original.cost).toBe("0.0497980000");
  const [receipt] = await InteractionBillingModel.findMany([original.id]);
  expect(receipt.usage.cost).toBe(original.cost);
  const counters = await db.select().from(schema.limitBillingUsageTable);
  const legacyCounters = await db.select().from(schema.limitModelUsageTable);

  // Simulate a row discovered before tier metadata existed. Registry refresh
  // must upgrade future pricing without a stored credential or history rewrite.
  const oldRow = await ModelModel.ensureModelExists(
    "gpt-6.1-sol",
    "github-copilot",
  );
  expect(oldRow?.syncedLongContextThreshold).toBeNull();
  await ModelModel.update(row.id, {
    customPricePerMillionInput: "0.03",
    customPricePerMillionOutput: "0.07",
  });
  const next = structuredClone(c.catalog);
  const tier = next["github-copilot"].models[modelId].cost?.tiers?.[0];
  if (!tier) throw new Error("Missing fixture tier");
  tier.input = 0.7;
  c.changeCatalog(next);
  modelsDevClient.clearFetchCache();
  expect(await modelsDevClient.syncModelMetadata(true)).toBe(2);
  const refreshed = await ModelModel.findById(row.id);
  expect(Number(refreshed?.syncedLongContextPromptPricePerToken)).toBe(
    0.0000007,
  );
  expect(refreshed?.customPricePerMillionInput).toBe("0.03");
  expect(refreshed?.discoveredViaLlmProxy).toBe(true);
  expect(
    (await ModelModel.findByProviderAndModelId("github-copilot", "gpt-6.1-sol"))
      ?.syncedLongContextThreshold,
  ).toBe(272_000);
  expect(
    await ModelModel.findByProviderAndModelId("github-copilot", "grok-4.7"),
  ).toBeNull();
  expect(await db.select().from(schema.llmProviderApiKeysTable)).toEqual([]);

  delete next["github-copilot"].models[modelId].cost?.tiers;
  c.changeCatalog(next);
  modelsDevClient.clearFetchCache();
  await modelsDevClient.syncModelMetadata(true);
  expect(
    (await ModelModel.findById(row.id))?.syncedLongContextThreshold,
  ).toBeNull();
  expect((await InteractionBillingModel.findMany([original.id]))[0]).toEqual(
    receipt,
  );
  expect(await db.select().from(schema.limitBillingUsageTable)).toEqual(
    counters,
  );
  expect(await db.select().from(schema.limitModelUsageTable)).toEqual(
    legacyCounters,
  );
  expect(
    (
      await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.id, original.id))
    )[0].cost,
  ).toBe(original.cost);
});
