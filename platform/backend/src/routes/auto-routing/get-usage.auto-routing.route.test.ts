import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import InteractionModel from "@/models/interaction";
import RoutingDecisionModel from "@/models/routing-decision";
import { beforeEach, describe, expect, test } from "@/test";
import {
  configureAutoRouter,
  makeScorerVersion,
  plannedDecision,
} from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import type { InsertInteraction } from "@/types/interaction";
import autoRoutingRoutes from "./auto-routing.routes";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("GET /api/auto-routing/routers/:id/usage", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  test("sums the last week per tier and prices the same tokens at the smart model", async ({
    makeAgent,
  }) => {
    const { router, trio } = await configureAutoRouter(ctx.organizationId);
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const scorer = await makeScorerVersion();
    const decide = async (tierIndex: number, session: string) =>
      (
        await RoutingDecisionModel.insertOrGet({
          ...plannedDecision({
            organizationId: ctx.organizationId,
            routerId: router.id,
            sessionKey: RoutingSessionKeySchema.parse(session),
            modelId: trio[tierIndex].id,
            scorerVersionId: scorer.id,
            tierIndex,
          }),
        })
      ).decision;
    const fast = await decide(0, "fast-session");
    const smart = await decide(2, "smart-session");

    // Two fast requests in one session, one smart request, one fast request too old to count.
    await record({ profileId: agent.id, decisionId: fast.id, cost: "1.00" });
    await record({ profileId: agent.id, decisionId: fast.id, cost: "1.00" });
    await record({ profileId: agent.id, decisionId: smart.id, cost: "22.50" });
    await record({
      profileId: agent.id,
      decisionId: fast.id,
      cost: "9.00",
      ago: 8 * DAY_MS,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/auto-routing/routers/${router.id}/usage`,
    });

    expect(response.statusCode, response.body).toBe(200);
    // Each request is 1M input and 0.1M output tokens: $22.50 on the smart model.
    expect(response.json()).toEqual({
      windowDays: 7,
      sessions: 2,
      requests: 3,
      costUsd: 24.5,
      allSmartCostUsd: 67.5,
      tiers: [
        { tier: "fast", sessions: 1, requests: 2, costUsd: 2 },
        { tier: "normal", sessions: 0, requests: 0, costUsd: 0 },
        { tier: "smart", sessions: 1, requests: 1, costUsd: 22.5 },
      ],
    });
  });

  test("is empty for a router that routed nothing", async () => {
    const { router } = await configureAutoRouter(ctx.organizationId);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/auto-routing/routers/${router.id}/usage`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      sessions: 0,
      requests: 0,
      costUsd: 0,
      allSmartCostUsd: 0,
    });
  });

  test("is not found for another organization's router", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const { router } = await configureAutoRouter(other.id);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/auto-routing/routers/${router.id}/usage`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("counts the last two weeks when asked for 14 days", async ({
    makeAgent,
  }) => {
    const { router, trio } = await configureAutoRouter(ctx.organizationId);
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const scorer = await makeScorerVersion();
    const { decision } = await RoutingDecisionModel.insertOrGet({
      ...plannedDecision({
        organizationId: ctx.organizationId,
        routerId: router.id,
        sessionKey: RoutingSessionKeySchema.parse("fast-session"),
        modelId: trio[0].id,
        scorerVersionId: scorer.id,
        tierIndex: 0,
      }),
    });
    await record({
      profileId: agent.id,
      decisionId: decision.id,
      cost: "1.00",
    });
    await record({
      profileId: agent.id,
      decisionId: decision.id,
      cost: "2.00",
      ago: 10 * DAY_MS,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/auto-routing/routers/${router.id}/usage?days=14`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      windowDays: 14,
      requests: 2,
      costUsd: 3,
    });
  });

  test("rejects a window the page does not offer", async () => {
    const { router } = await configureAutoRouter(ctx.organizationId);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/auto-routing/routers/${router.id}/usage?days=30`,
    });

    expect(response.statusCode).toBe(400);
  });
});

async function record(params: {
  profileId: string;
  decisionId: string;
  cost: string;
  ago?: number;
}) {
  const id = randomUUID();
  const interaction: InsertInteraction = {
    id,
    profileId: params.profileId,
    autoRoutingDecisionId: params.decisionId,
    type: "openai:chatCompletions",
    model: "gpt-4o",
    request: { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    response: {
      id: "response",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    },
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cost: params.cost,
  };
  await InteractionModel.record(interaction);
  if (params.ago) {
    await db
      .update(schema.routingUsageTable)
      .set({ createdAt: new Date(Date.now() - params.ago) })
      .where(eq(schema.routingUsageTable.interactionId, id));
  }
}
