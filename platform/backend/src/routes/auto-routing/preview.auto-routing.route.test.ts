import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import { beforeEach, describe, expect, test } from "@/test";
import {
  configureAutoRouting,
  makeScorerVersion,
  publishFittedPlan,
} from "@/test/auto-routing";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

/** Jev answers that make the smart tier the only adequate one. */
const SMART_ANSWERS = {
  model: "jev-1.13.0",
  answers: {
    tier_needed: {
      type: "score",
      score: 2,
      confidence: 0.9,
      probabilities: { "0": 0, "1": 0, "2": 1 },
    },
    long_context: { type: "noul", noul: 0.1 },
  },
  usage: { input_tokens: 420, output_tokens: 6, cost: 0.0001 },
};

describe("POST /api/auto-routing/preview", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  const server = useMswServer();
  let jevStates: unknown[];

  beforeEach(async ({ makeSecret, makeLlmProviderApiKey }) => {
    config.autoRouting.enabled = true;
    jevStates = [];
    server.use(
      http.post(config.llm.jev.baseUrl, async ({ request }) => {
        const body = (await request.json()) as { state: unknown };
        jevStates.push(body.state);
        return HttpResponse.json(SMART_ANSWERS);
      }),
    );
    const secret = await makeSecret({ secret: { apiKey: "sk-jev" } });
    await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
      provider: "jev",
    });
  });

  const preview = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/auto-routing/preview",
      payload,
    });

  test("scores the text and decides with the active plan, storing nothing", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const plan = await publishFittedPlan({
      organizationId: ctx.organizationId,
      trio,
    });
    const before = await AutoRoutingSettingsModel.find(ctx.organizationId);

    const response = await preview({ text: "Refactor the billing module" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      tierNeeded: [0, 0, 1],
      pLong: 0.1,
      reason: "planned",
      planId: plan.id,
      chosen: {
        tier: "smart",
        model: { id: trio[2].id, provider: "openai", modelId: trio[2].modelId },
      },
      propensity: 1,
      expectedCostUsd: expect.any(Number),
      scorerCostUsd: 0.0001,
    });
    expect(jevStates).toEqual([{ prompt: "Refactor the billing module" }]);
    expect(await db.$count(schema.routingDecisionsTable)).toBe(0);
    expect(await db.$count(schema.routingUsageTable)).toBe(0);
    expect(await AutoRoutingSettingsModel.find(ctx.organizationId)).toEqual(
      before,
    );
  });

  test("a plan fitted for another scorer version reports a cold start", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await publishFittedPlan({
      organizationId: ctx.organizationId,
      trio,
      scorerVersionId: (await makeScorerVersion()).id,
    });

    const response = await preview({ text: "Refactor the billing module" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      reason: "cold_start",
      planId: null,
      chosen: { tier: "normal" },
    });
  });

  test.each([
    {
      messages: [
        { role: "system", content: "Review migration locking." },
        { role: "user", content: "Review this change." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "inspect_schema",
            description: "Read table metadata.",
            parameters: { private: "not scored" },
          },
        },
      ],
    },
    {
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "Review migration locking." }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "Review this change." }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "inspect_schema",
          description: "Read table metadata.",
          parameters: null,
        },
      ],
    },
    {
      system: [{ type: "text", text: "Review migration locking." }],
      messages: [{ role: "user", content: "Review this change." }],
      tools: [
        {
          name: "inspect_schema",
          description: "Read table metadata.",
          input_schema: {},
        },
      ],
    },
  ])("scores request context through the live extractor without saving a decision (shape %#)", async (request) => {
    await configureAutoRouting(ctx.organizationId);

    const response = await preview({ request });

    expect(response.statusCode, response.body).toBe(200);
    expect(jevStates).toEqual([
      {
        prompt: "Review this change.",
        system_prompt: "Review migration locking.",
        tools: "Available tools: 1\ninspect_schema: Read table metadata.",
      },
    ]);
    expect(await db.$count(schema.routingDecisionsTable)).toBe(0);
    expect(await db.$count(schema.routingUsageTable)).toBe(0);
  });

  test.each([
    {
      request: {
        instructions: "System instructions alone are not a user task.",
      },
    },
    { text: "Task", request: { input: "Ambiguous task" } },
    { request: [] },
    { request: { input: "x".repeat(256 * 1024) } },
  ])("rejects invalid or oversized request previews before scoring (case %#)", async (payload) => {
    await configureAutoRouting(ctx.organizationId);
    const response = await preview(payload);
    expect([400, 413]).toContain(response.statusCode);
    expect(jevStates).toEqual([]);
  });

  test("without a plan, reports the cold-start normal tier", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);

    const response = await preview({ text: "Fix a typo" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      reason: "cold_start",
      planId: null,
      chosen: { tier: "normal", model: { id: trio[1].id } },
      propensity: 1,
      expectedCostUsd: null,
    });
  });

  test("a plan for other prices falls back without requesting a re-plan", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    await publishFittedPlan({ organizationId: ctx.organizationId, trio });
    const repriced = await configureAutoRouting(ctx.organizationId);
    const before = await AutoRoutingSettingsModel.find(ctx.organizationId);

    const response = await preview({ text: "Fix a typo" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      reason: "plan_stale",
      chosen: { tier: "normal", model: { id: repriced[1].id } },
    });
    expect(await AutoRoutingSettingsModel.find(ctx.organizationId)).toEqual(
      before,
    );
  });

  test("rejects text over the cap without calling the scorer", async () => {
    await configureAutoRouting(ctx.organizationId);

    const response = await preview({ text: "x".repeat(20_001) });

    expect(response.statusCode).toBe(400);
    expect(jevStates).toEqual([]);
  });

  test("needs a configured trio", async () => {
    const response = await preview({ text: "Fix a typo" });

    expect(response.statusCode).toBe(400);
    expect(jevStates).toEqual([]);
  });
});
