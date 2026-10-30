import db from "@/database";
import { createInteractionsIndexes } from "@/database/index-maintenance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import ModelModel from "@/models/model";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./llm-provider-models";

describe("model cost backfill routes", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async () => {
    registerAuditLogHook(ctx.app);
    await createInteractionsIndexes({
      concurrently: false,
      client: {
        query: (text: string, values?: unknown[]) =>
          db.$client.query(text, values),
      },
    });
  });

  test("an editor previews, starts and follows a recompute, and the start is audited", async ({
    makeAgent,
    makeInteraction,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const model = await createModel();
    const agent = await makeAgent();
    await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: model.modelId,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cost: "50.0000000000",
      createdAt: new Date("2026-10-01T12:00:00Z"),
    });

    const preview = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill/preview`,
      payload: {
        timeZone: "UTC",
        since: "2026-09-01T00:00:00.000Z",
        prices: { input: "2", output: "10", cacheRead: null, cacheWrite: null },
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      availability: "available",
      days: [{ day: "2026-10-01", requests: 1, recordedCost: 50 }],
      window: { requests: 1, recordedCost: 50, recomputedCost: 2 },
    });

    // Save, then start at the saved prices, as the edit dialog does. A price
    // written differently from how it's stored still matches.
    const saved = await ctx.app.inject({
      method: "PATCH",
      url: `/api/llm-models/${model.id}`,
      payload: {
        customPricePerMillionInput: "2",
        customPricePerMillionOutput: "10.0",
        customPricePerMillionCacheRead: null,
        customPricePerMillionCacheWrite: null,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const stale = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill`,
      payload: {
        since: "2026-09-01T00:00:00.000Z",
        prices: { input: "3", output: "15", cacheRead: null, cacheWrite: null },
      },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const started = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill`,
      payload: {
        since: "2026-09-01T00:00:00.000Z",
        prices: {
          input: "2",
          output: "10",
          cacheRead: null,
          cacheWrite: null,
        },
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({
      modelId: model.id,
      status: "pending",
      rowsEstimated: 1,
    });
    expect(started.json()).not.toHaveProperty("leaseOwner");

    const again = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill`,
      payload: { since: null },
    });
    expect(again.statusCode).toBe(409);

    const status = await ctx.app.inject({
      method: "GET",
      url: `/api/llm-models/${model.id}/cost-backfill`,
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({
      id: started.json().id,
      status: "pending",
    });

    const audit = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      limit: 10,
      offset: 0,
    });
    // The save, and each start including the refused ones; previews aren't.
    expect(audit.data.map((row) => row.action).sort()).toEqual([
      "llmModel.cost_backfill_started",
      "llmModel.cost_backfill_started",
      "llmModel.cost_backfill_started",
      "llmModel.updated",
    ]);
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "llmModel.cost_backfill_started",
          outcome: "failure",
          httpStatus: 409,
        }),
        expect.objectContaining({
          action: "llmModel.cost_backfill_started",
          outcome: "success",
          before: null,
          after: expect.objectContaining({
            id: started.json().id,
            since: "2026-09-01T00:00:00.000Z",
            pricing: expect.objectContaining({
              pricePerMillionInput: "2.00000000",
            }),
          }),
        }),
      ]),
    );
  });

  test("preview, save and start agree on eight-decimal prices and detect a one-unit stale edit", async ({
    makeMember,
    makeAgent,
    makeInteraction,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const model = await createModel();
    const agent = await makeAgent();
    await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: model.modelId,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cost: "1.0000000000",
    });
    const prices = {
      input: "0.000000015",
      output: "0.123456785",
      cacheRead: null,
      cacheWrite: null,
    };
    const preview = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill/preview`,
      payload: { timeZone: "UTC", since: "1970-01-01T00:00:00.000Z", prices },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().window.recomputedCost).toBe(0.00000002);
    const saved = await ctx.app.inject({
      method: "PATCH",
      url: `/api/llm-models/${model.id}`,
      payload: {
        customPricePerMillionInput: prices.input,
        customPricePerMillionOutput: prices.output,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      customPricePerMillionInput: "0.00000002",
      customPricePerMillionOutput: "0.12345679",
    });
    const stale = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill`,
      payload: { since: null, prices: { ...prices, input: "0.00000003" } },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const started = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill`,
      payload: { since: null, prices },
    });
    expect(started.statusCode, started.body).toBe(200);
    const audit = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "llmModel.updated",
          outcome: "success",
          after: expect.objectContaining({
            pricePerMillionInput: "0.00000002",
          }),
        }),
        expect.objectContaining({
          action: "llmModel.cost_backfill_started",
          outcome: "success",
          after: expect.objectContaining({
            pricing: expect.objectContaining({
              pricePerMillionInput: "0.00000002",
              pricePerMillionOutput: "0.12345679",
            }),
          }),
        }),
      ]),
    );
  });

  test("preview and start reject prices outside the model price contract", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const model = await createModel();
    for (const input of [
      "99999999.990000001",
      "100000000",
      "-1e-999",
      "1usd",
    ]) {
      for (const endpoint of ["cost-backfill/preview", "cost-backfill"]) {
        const response = await ctx.app.inject({
          method: "POST",
          url: `/api/llm-models/${model.id}/${endpoint}`,
          payload: {
            since: null,
            ...(endpoint.endsWith("preview") ? { timeZone: "UTC" } : {}),
            prices: { input, output: "0", cacheRead: null, cacheWrite: null },
          },
        });
        expect(response.statusCode, `${endpoint}: ${input}`).toBe(400);
      }
    }
  });

  test("accepts named time zones and rejects anything else", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const model = await createModel();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill/preview`,
      payload: { timeZone: "Mars/Olympus_Mons" },
    });
    expect(response.statusCode).toBe(400);

    // Current names browsers report, missing from the canonical list.
    for (const timeZone of ["Asia/Kolkata", "Europe/Kyiv", "Etc/UTC"]) {
      const named = await ctx.app.inject({
        method: "POST",
        url: `/api/llm-models/${model.id}/cost-backfill/preview`,
        payload: { timeZone },
      });
      expect(named.statusCode, `${timeZone}: ${named.body}`).toBe(200);
    }
    const offset = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill/preview`,
      payload: { timeZone: "+05:30" },
    });
    expect(offset.statusCode).toBe(400);
  });

  test("a member who cannot edit the model can neither preview nor start", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
    const model = await createModel();
    for (const request of [
      {
        method: "POST" as const,
        url: `/api/llm-models/${model.id}/cost-backfill/preview`,
        payload: { timeZone: "UTC" },
      },
      {
        method: "POST" as const,
        url: `/api/llm-models/${model.id}/cost-backfill`,
        payload: { since: null },
      },
      {
        method: "GET" as const,
        url: `/api/llm-models/${model.id}/cost-backfill`,
      },
    ]) {
      expect((await ctx.app.inject(request)).statusCode).toBe(403);
    }
  });
});

let modelCounter = 0;

function createModel() {
  modelCounter += 1;
  const modelId = `claude-route-backfill-${modelCounter}`;
  return ModelModel.create({
    externalId: `anthropic/${modelId}`,
    provider: "anthropic",
    modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    customPricePerMillionInput: "3",
    customPricePerMillionOutput: "15",
  });
}
