import { randomUUID } from "node:crypto";
import { activeSourceVersion } from "@/auto-routing/signals";
import config from "@/config";
import db, { schema } from "@/database";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import {
  activeFit,
  configureAutoRouting,
  makeScorerVersion,
  plannedDecision,
  publishFittedPlan,
} from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import autoRoutingRoutes from "./auto-routing.routes";

describe("GET /api/auto-routing/settings", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  const getSettings = () =>
    ctx.app.inject({ method: "GET", url: "/api/auto-routing/settings" });

  test("an unconfigured organization reads defaults", async () => {
    const response = await getSettings();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      enabled: false,
      budgetUsdPerDay: null,
      tiers: { fast: null, normal: null, smart: null },
      routedAgentCount: 0,
      generation: 0,
      plannedGeneration: 0,
      status: {
        activePlan: null,
        coldStart: {
          scorerVersionId: (await activeSourceVersion()).id,
          sessions: 0,
          required: 1000,
        },
        lastFitError: null,
        scorer: "no_jev_key",
      },
    });
  });

  test("reports the scorer ready once the organization has a Jev key", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-jev" } });
    await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
      provider: "jev",
    });

    const response = await getSettings();

    expect(response.json().status.scorer).toBe("ready");
  });

  test("reports the trio, the routed agents, the active plan, the last fit error and cold-start progress", async ({
    makeAgent,
  }) => {
    const trio = await configureAutoRouting(ctx.organizationId);
    // Counted: agents on the organization default. Not counted: the LLM Proxy configureAutoRouting created.
    await makeAgent({ organizationId: ctx.organizationId, agentType: "agent" });
    await makeAgent({ organizationId: ctx.organizationId, agentType: "agent" });
    const plan = await publishFittedPlan({
      organizationId: ctx.organizationId,
      trio,
    });
    await RoutingPlanModel.publish({
      ...activeFit({
        organizationId: ctx.organizationId,
        scorerVersionId: plan.scorerVersionId,
        generation: plan.generation,
        inputWatermark: new Date(),
      }),
      outcome: {
        status: "failed",
        error: "solver diverged",
        diagnostics: null,
      },
    });
    const running = await activeSourceVersion();
    const other = await makeScorerVersion();
    // Counted: idle sessions of the running version. Not counted: still active, no usage, another version.
    await decide(running.id, trio[1].id, { lastUsageHoursAgo: 30 });
    await decide(running.id, trio[1].id, { lastUsageHoursAgo: 25 });
    await decide(running.id, trio[1].id, { lastUsageHoursAgo: 1 });
    await decide(running.id, trio[1].id, { lastUsageHoursAgo: null });
    await decide(other.id, trio[1].id, { lastUsageHoursAgo: 30 });

    const response = await getSettings();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      enabled: true,
      budgetUsdPerDay: 50,
      tiers: {
        fast: { id: trio[0].id, provider: "openai", modelId: trio[0].modelId },
        normal: {
          id: trio[1].id,
          provider: "openai",
          modelId: trio[1].modelId,
        },
        smart: { id: trio[2].id, provider: "openai", modelId: trio[2].modelId },
      },
      routedAgentCount: 2,
      generation: 2,
      plannedGeneration: 2,
      status: {
        activePlan: { id: plan.id, createdAt: plan.createdAt.toISOString() },
        coldStart: { scorerVersionId: running.id, sessions: 2, required: 1000 },
        lastFitError: "solver diverged",
        scorer: "no_jev_key",
      },
    });
  });

  async function decide(
    scorerVersionId: string,
    modelId: string,
    { lastUsageHoursAgo }: { lastUsageHoursAgo: number | null },
  ) {
    const { decision } = await RoutingDecisionModel.insertOrGet(
      plannedDecision({
        organizationId: ctx.organizationId,
        sessionKey: RoutingSessionKeySchema.parse(randomUUID()),
        modelId,
        scorerVersionId,
      }),
    );
    if (lastUsageHoursAgo === null) return;
    await db.insert(schema.routingUsageTable).values({
      interactionId: randomUUID(),
      decisionId: decision.id,
      createdAt: new Date(Date.now() - lastUsageHoursAgo * 60 * 60 * 1000),
      input: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 10,
      estimated: false,
    });
  }
});
