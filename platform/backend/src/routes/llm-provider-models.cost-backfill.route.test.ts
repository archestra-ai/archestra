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

    const started = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill`,
      payload: { since: "2026-09-01T00:00:00.000Z" },
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
      resourceId: model.id,
      limit: 10,
      offset: 0,
    });
    // The refused second start is recorded too, as a failure.
    expect(audit.data).toHaveLength(2);
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
            pricing: expect.objectContaining({ pricePerMillionInput: "3.00" }),
          }),
        }),
      ]),
    );
  });

  test("rejects an unknown time zone", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const model = await createModel();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/llm-models/${model.id}/cost-backfill/preview`,
      payload: { timeZone: "Mars/Olympus_Mons" },
    });
    expect(response.statusCode).toBe(400);
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
