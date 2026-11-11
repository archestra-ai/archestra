import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  activeSourceVersion,
  DEFAULT_SCORER_MODEL,
} from "@/auto-routing/signals";
import config from "@/config";
import db, { schema } from "@/database";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import {
  activeFit,
  autoRouterId,
  configureAutoRouting,
  ensureAutoRouter,
  makeScorerVersion,
  plannedDecision,
  publishFittedPlan,
} from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import autoRoutingRoutes from "./auto-routing.routes";

describe("GET /api/auto-routing/routers and /state", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  const getRouters = () =>
    ctx.app.inject({ method: "GET", url: "/api/auto-routing/routers" });
  const getState = () =>
    ctx.app.inject({ method: "GET", url: "/api/auto-routing/state" });

  test("an organization without routers reads the switch off and lists none", async () => {
    const state = await getState();
    const routers = await getRouters();

    expect(state.statusCode, state.body).toBe(200);
    expect(state.json()).toMatchObject({
      enabled: false,
      eligibleApiKeyIds: [],
    });
    expect(routers.statusCode, routers.body).toBe(200);
    expect(routers.json()).toEqual([]);
  });

  test("an unconfigured router reads defaults", async () => {
    const router = await ensureAutoRouter(ctx.organizationId);

    const response = await getRouters();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([
      {
        id: router.id,
        name: "auto",
        enabled: false,
        budgetUsdPerDay: null,
        budgetPreset: null,
        tiers: { fast: null, normal: null, smart: null },
        decisionModel: { apiKeyId: null, model: DEFAULT_SCORER_MODEL },
        usesPastSessions: true,
        virtualApiKeyIds: [],
        usage: { agentCount: 0, organizationDefault: false },
        generation: 1,
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
          scorerApiKey: null,
        },
      },
    ]);
  });

  test("reports the scorer ready once the organization has a Jev key", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-jev" } });
    const jevKey = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
      provider: "jev",
    });

    await ensureAutoRouter(ctx.organizationId);

    const response = await getRouters();

    expect(response.json()[0].status.scorer).toBe("ready");
    expect(response.json()[0].status.scorerApiKey).toEqual({
      id: jevKey.id,
      name: jevKey.name,
    });
  });

  test("reports the tiers, where auto is used, the active plan, the last fit error and cold-start progress", async ({
    makeAgent,
  }) => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);
    const [key] = await db
      .select({
        id: schema.llmProviderApiKeysTable.id,
        name: schema.llmProviderApiKeysTable.name,
      })
      .from(schema.autoRoutingTiersTable)
      .innerJoin(
        schema.llmProviderApiKeysTable,
        eq(
          schema.llmProviderApiKeysTable.id,
          schema.autoRoutingTiersTable.providerApiKeyId,
        ),
      )
      .where(eq(schema.autoRoutingTiersTable.routerId, routerId))
      .limit(1);
    // Counted: agents set to auto. Not counted: agents on a model of their own.
    await makeAgent({
      organizationId: ctx.organizationId,
      autoRouterId: routerId,
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      autoRouterId: routerId,
    });
    await makeAgent({ organizationId: ctx.organizationId });
    const plan = await publishFittedPlan({
      organizationId: ctx.organizationId,
      trio,
    });
    await RoutingPlanModel.publish({
      ...activeFit({
        organizationId: ctx.organizationId,
        routerId,
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

    const response = await getRouters();
    const state = await getState();

    expect(response.statusCode, response.body).toBe(200);
    expect(state.json().eligibleApiKeyIds).toEqual([key.id]);
    expect(response.json()).toEqual([
      {
        id: routerId,
        name: "auto",
        enabled: true,
        budgetUsdPerDay: 50,
        budgetPreset: null,
        tiers: {
          fast: {
            id: trio[0].id,
            provider: "openai",
            modelId: trio[0].modelId,
            apiKey: key,
          },
          normal: {
            id: trio[1].id,
            provider: "openai",
            modelId: trio[1].modelId,
            apiKey: key,
          },
          smart: {
            id: trio[2].id,
            provider: "openai",
            modelId: trio[2].modelId,
            apiKey: key,
          },
        },
        decisionModel: { apiKeyId: null, model: DEFAULT_SCORER_MODEL },
        usesPastSessions: true,
        virtualApiKeyIds: [],
        usage: { agentCount: 2, organizationDefault: false },
        generation: 2,
        plannedGeneration: 2,
        status: {
          activePlan: { id: plan.id, createdAt: plan.createdAt.toISOString() },
          coldStart: {
            scorerVersionId: running.id,
            sessions: 2,
            required: 1000,
          },
          lastFitError: "solver diverged",
          scorer: "no_jev_key",
          scorerApiKey: null,
        },
      },
    ]);
  });

  test("lists each router with its own tiers, plan and usage", async ({
    makeAgent,
  }) => {
    await configureAutoRouting(ctx.organizationId);
    const first = await autoRouterId(ctx.organizationId);
    const second = await ensureAutoRouter(ctx.organizationId, "auto:support");
    await makeAgent({
      organizationId: ctx.organizationId,
      autoRouterId: first,
    });

    const response = await getRouters();

    const [a, b] = response.json();
    expect([a.id, b.id]).toEqual([first, second.id]);
    expect([a.name, b.name]).toEqual(["auto", "auto:support"]);
    expect([a.usesPastSessions, b.usesPastSessions]).toEqual([true, false]);
    expect(a.usage.agentCount).toBe(1);
    expect(b.usage.agentCount).toBe(0);
    expect(a.tiers.normal).not.toBeNull();
    expect(b.tiers.normal).toBeNull();
  });

  async function decide(
    scorerVersionId: string,
    modelId: string,
    { lastUsageHoursAgo }: { lastUsageHoursAgo: number | null },
  ) {
    const { decision } = await RoutingDecisionModel.insertOrGet(
      plannedDecision({
        organizationId: ctx.organizationId,
        routerId: await autoRouterId(ctx.organizationId),
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
