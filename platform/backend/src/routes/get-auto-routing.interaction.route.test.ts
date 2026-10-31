import { randomUUID } from "node:crypto";
import db from "@/database";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingUsageModel from "@/models/routing-usage";
import { beforeEach, describe, expect, test } from "@/test";
import {
  makeRoutingModel,
  makeScorerVersion,
  plannedDecision,
} from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import interactionRoutes from "./interaction";

describe("GET /api/interactions/:interactionId/auto-routing", () => {
  const ctx = useRouteTestApp(interactionRoutes);
  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
  });
  const read = (id: string) =>
    ctx.app.inject({
      method: "GET",
      url: `/api/interactions/${id}/auto-routing`,
    });

  test("returns persisted provenance through the usage link, not a session-name guess", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const model = await makeRoutingModel();
    const scorer = await makeScorerVersion();
    const sessionId = "shared-session";
    const routed = await makeInteraction(agent.id, {
      userId: ctx.user.id,
      sessionId,
    });
    const unrelated = await makeInteraction(agent.id, {
      userId: ctx.user.id,
      sessionId,
    });
    const { decision } = await RoutingDecisionModel.insertOrGet({
      ...plannedDecision({
        organizationId: ctx.organizationId,
        sessionKey: RoutingSessionKeySchema.parse(sessionId),
        modelId: model.id,
        scorerVersionId: scorer.id,
      }),
      lambda: 42,
      expectedCostUsd: "0.125",
    });
    await db.transaction((tx) =>
      RoutingUsageModel.record(tx, {
        interactionId: routed.id,
        decisionId: decision.id,
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        estimated: false,
      }),
    );

    const response = await read(routed.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().decision).toMatchObject({
      id: decision.id,
      tierIndex: 1,
      tier: "normal",
      reason: "planned",
      planId: decision.planId,
      lambda: 42,
      propensity: 1,
      model: { id: model.id, provider: "openai", modelId: model.modelId },
      features: {
        signals: {
          "jev-session": { tier_needed: [0.2, 0.5, 0.3], p_long: 0.1 },
        },
      },
      scorerVersion: {
        id: scorer.id,
        model: scorer.model,
        specHash: scorer.specHash,
      },
    });
    expect(Number(response.json().decision.expectedCostUsd)).toBe(0.125);
    expect(response.json().decision).not.toHaveProperty("organizationId");
    expect(response.json().decision).not.toHaveProperty("sessionKey");
    const unlinked = await read(unrelated.id);
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json()).toEqual({ decision: null });

    await RoutingDecisionModel.purgeExpired(
      new Date(Date.now() + 91 * 24 * 60 * 60 * 1000),
    );
    expect((await read(routed.id)).json()).toEqual({ decision: null });
  });

  test("returns a recorded scorer fallback without inventing probabilities", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const interaction = await makeInteraction(agent.id, {
      userId: ctx.user.id,
    });
    const model = await makeRoutingModel();
    const scorer = await makeScorerVersion();
    const { decision } = await RoutingDecisionModel.insertOrGet({
      ...plannedDecision({
        organizationId: ctx.organizationId,
        sessionKey: RoutingSessionKeySchema.parse("fallback"),
        modelId: model.id,
        scorerVersionId: scorer.id,
      }),
      reason: "scorer_error",
      features: null,
    });
    await db.transaction((tx) =>
      RoutingUsageModel.record(tx, {
        interactionId: interaction.id,
        decisionId: decision.id,
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        estimated: false,
      }),
    );
    const response = await read(interaction.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().decision).toMatchObject({
      reason: "scorer_error",
      features: null,
      lambda: null,
      expectedCostUsd: null,
    });
  });

  test("hides other users, unattributed rows and foreign organizations", async ({
    makeAgent,
    makeInteraction,
    makeUser,
    makeOrganization,
  }) => {
    const ownAgent = await makeAgent({ organizationId: ctx.organizationId });
    const otherUser = await makeUser();
    const other = await makeInteraction(ownAgent.id, { userId: otherUser.id });
    const unattributed = await makeInteraction(ownAgent.id, { userId: null });
    const foreignOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: foreignOrg.id });
    const foreign = await makeInteraction(foreignAgent.id, {
      userId: ctx.user.id,
    });
    for (const id of [other.id, unattributed.id, foreign.id, randomUUID()]) {
      const response = await read(id);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).not.toHaveProperty("decision");
    }
  });

  test("log administrators can inspect unattributed logs in their organization", async ({
    makeAgent,
    makeInteraction,
    makeUser,
    makeMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, ctx.organizationId, { role: "admin" });
    ctx.user = admin;
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const interaction = await makeInteraction(agent.id, { userId: null });
    const response = await read(interaction.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ decision: null });
  });
});
