import { plan as fitPlan } from "@archestra/router-rs";
import {
  AUTO_ROUTABLE_HEADER,
  CHAT_API_KEY_ID_HEADER,
  MEMBER_ROLE_NAME,
  PROVIDER_BASE_URL_HEADER,
  type ResourcePermissionGrant,
  USER_ID_HEADER,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { delay, HttpResponse, http } from "msw";
import { onTestFinished, vi } from "vitest";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import { activeSourceVersion } from "@/auto-routing/signals";
import { type Trio, tiersFingerprint } from "@/auto-routing/tiers";
import { internalCallHeader } from "@/clients/internal-call";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AgentModel,
  LimitModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  ModelPoolModel,
  VirtualApiKeyModel,
} from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import LlmThroughputModel from "@/models/llm-throughput";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingPlanModel from "@/models/routing-plan";
import RoutingScorerVersionModel from "@/models/routing-scorer-version";
import { secretManager } from "@/secrets-manager";
import { handleAutoRoutingFit } from "@/task-queue/handlers/auto-routing-fit-handler";
import { accessGrants, beforeEach, describe, expect, test } from "@/test";
import { setOrganizationTrio } from "@/test/auto-routing";
import { seedFitHistory } from "@/test/auto-routing-fit";
import { useMswServer } from "@/test/msw";
import { ApiError, type Model } from "@/types";
import {
  type RoutingDecision,
  RoutingSessionKeySchema,
} from "@/types/auto-routing";
import { STREAM_KEEPALIVE_SSE_COMMENT } from "../stream-keepalive";
import modelRouterProxyRoutes from "./model-router";
import openAiProxyRoutes from "./openai";

const UPSTREAM = "https://openai.auto-routing.test/v1";
const JEV = config.llm.jev.baseUrl;
const PROMPT = "Refactor the billing module and fix the flaky tests";
const ENDPOINTS = [
  { ingress: "chat", path: "chat/completions" },
  { ingress: "responses", path: "responses" },
] as const;
type Ingress = (typeof ENDPOINTS)[number]["ingress"];

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

type Org = Awaited<ReturnType<typeof setupOrganization>>;

describe("Model Router auto model", () => {
  const server = useMswServer();
  let upstreamModels: string[];
  let jevCalls: number;

  beforeEach(() => {
    config.autoRouting.enabled = true;
    upstreamModels = [];
    jevCalls = 0;
    server.use(
      http.post(JEV, () => {
        jevCalls += 1;
        return HttpResponse.json(SMART_ANSWERS);
      }),
      http.post(`${UPSTREAM}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as { model: string };
        upstreamModels.push(body.model);
        return HttpResponse.json(chatCompletion(body.model));
      }),
      http.post(`${UPSTREAM}/responses`, async ({ request }) => {
        const body = (await request.json()) as { model: string };
        upstreamModels.push(body.model);
        return HttpResponse.json(responsesResponse(body.model));
      }),
    );
  });

  for (const { ingress, path } of ENDPOINTS) {
    describe(`${ingress} ingress`, () => {
      test("routes a planned session to the chosen tier and records its usage", async ({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const org = await setupOrganization({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
        });
        await publishPlan(org);

        const response = await send(org, { ingress, path, session: "s-1" });

        expect(response.statusCode, response.body).toBe(200);
        expect(upstreamModels).toEqual([org.trio[2].modelId]);
        const [decision] = await decisions(org.organizationId);
        expect(decision).toMatchObject({
          reason: "planned",
          tierIndex: 2,
          modelId: org.trio[2].id,
          propensity: 1,
          // the budget affords everyone's best tier, so the plan's λ* is 0
          lambda: 0,
        });
        expect(Number(decision.expectedCostUsd)).toBeGreaterThan(0);
        const version = (await activeSourceVersion()).id;
        expect(decision).toMatchObject({
          scorerVersionId: version,
          featuresSchemaVersion: 1,
        });
        expect(decision.features).toEqual({
          signals: {
            "jev-session": { version, tier_needed: [0, 0, 1], p_long: 0.1 },
          },
          client: expect.any(String),
        });
        expect(await usage(decision.id)).toEqual([
          expect.objectContaining({ input: 12, output: 10 }),
        ]);
      });

      test("replays a session's tier without scoring it again", async ({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const org = await setupOrganization({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
        });
        await publishPlan(org);

        const first = await send(org, { ingress, path, session: "s-1" });
        const second = await send(org, {
          ingress,
          path,
          session: "s-1",
          prompt: "A later turn with different text",
        });

        expect(first.statusCode, first.body).toBe(200);
        expect(second.statusCode, second.body).toBe(200);
        expect(upstreamModels).toEqual([
          org.trio[2].modelId,
          org.trio[2].modelId,
        ]);
        expect(jevCalls).toBe(1);
        const [decision] = await decisions(org.organizationId);
        expect(await usage(decision.id)).toHaveLength(2);
      });

      test("concurrent first requests of a session share one decision", async ({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const org = await setupOrganization({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
        });
        await publishPlan(org);

        const responses = await Promise.all(
          [1, 2, 3].map(() => send(org, { ingress, path, session: "s-1" })),
        );

        expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
        expect(jevCalls).toBe(1);
        const rows = await decisions(org.organizationId);
        expect(rows).toHaveLength(1);
        expect(new Set(upstreamModels)).toEqual(
          new Set([org.trio[rows[0].tierIndex].modelId]),
        );
        expect(await usage(rows[0].id)).toHaveLength(3);
      });

      test("routes to the normal tier while no plan exists", async ({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const org = await setupOrganization({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
        });

        const response = await send(org, { ingress, path, session: "s-1" });

        expect(response.statusCode, response.body).toBe(200);
        expect(upstreamModels).toEqual([org.trio[1].modelId]);
        expect(await decisions(org.organizationId)).toEqual([
          expect.objectContaining({
            reason: "cold_start",
            tierIndex: 1,
            planId: null,
            features: expect.objectContaining({ client: expect.any(String) }),
            lambda: null,
            expectedCostUsd: null,
          }),
        ]);
      });

      test("falls back to the normal tier when the scorer times out", async ({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const org = await setupOrganization({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
        });
        const plan = await publishPlan(org);
        config.autoRouting.scorerTimeoutMs = 50;
        server.use(
          http.post(JEV, async () => {
            await delay(1_000);
            return HttpResponse.json(SMART_ANSWERS);
          }),
        );

        const response = await send(org, { ingress, path, session: "s-1" });

        expect(response.statusCode, response.body).toBe(200);
        expect(upstreamModels).toEqual([org.trio[1].modelId]);
        expect(await decisions(org.organizationId)).toEqual([
          expect.objectContaining({
            reason: "scorer_error",
            tierIndex: 1,
            planId: plan.id,
            features: null,
          }),
        ]);
      });

      test("falls back and requests a re-plan once tier prices changed", async ({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const org = await setupOrganization({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
        });
        await publishPlan(org);
        const before = await AutoRoutingSettingsModel.find(org.organizationId);
        await ModelModel.update(org.trio[0].id, {
          customPricePerMillionInput: "2.00",
        });

        const response = await send(org, { ingress, path, session: "s-1" });

        expect(response.statusCode, response.body).toBe(200);
        expect(upstreamModels).toEqual([org.trio[1].modelId]);
        expect(await decisions(org.organizationId)).toEqual([
          expect.objectContaining({ reason: "plan_stale", planId: null }),
        ]);
        const after = await AutoRoutingSettingsModel.find(org.organizationId);
        expect(after?.generation).toBeGreaterThan(before?.generation ?? 0);
      });

      test("rejects a session whose routed tier became unreachable", async ({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const org = await setupOrganization({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
        });
        await publishPlan(org);
        const first = await send(org, { ingress, path, session: "s-1" });
        expect(first.statusCode, first.body).toBe(200);

        await unlink(org, org.trio[2]);
        const replay = await send(org, { ingress, path, session: "s-1" });

        expect(replay.statusCode).toBe(400);
        expect(replay.json().error.message).toContain("smart tier");
        expect(upstreamModels).toHaveLength(1);
      });
    });
  }

  test("a plan of another scorer version cold-starts and activates the running version once", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const previous = await RoutingScorerVersionModel.upsert({
      name: "previous",
      model: "jev-1.12.0",
      spec: { name: "previous" },
      specHash: crypto.randomUUID(),
    });
    await publishPlan(org, (plan) => plan, previous.id);
    const before = await AutoRoutingSettingsModel.find(org.organizationId);

    for (const session of ["s-1", "s-2"]) {
      const response = await send(org, {
        ingress: "chat",
        path: "chat/completions",
        session,
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    expect(upstreamModels).toEqual([org.trio[1].modelId, org.trio[1].modelId]);
    const rows = await decisions(org.organizationId);
    expect(rows.map((row) => [row.reason, row.planId])).toEqual([
      ["cold_start", null],
      ["cold_start", null],
    ]);
    expect(
      await AutoRoutingSettingsModel.find(org.organizationId),
    ).toMatchObject({
      scorerVersionId: (await activeSourceVersion()).id,
      generation: (before?.generation ?? 0) + 1,
    });
  });

  test("a caller over its usage limit is refused before the scorer is called", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    await publishPlan(org);
    const [key] = await db
      .select({ id: schema.virtualApiKeysTable.id })
      .from(schema.virtualApiKeysTable)
      .where(eq(schema.virtualApiKeysTable.organizationId, org.organizationId));
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: key.id,
      limitType: "token_cost",
      limitValue: 1,
      model: null,
      lastCleanup: new Date(),
    });
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      key.id,
      org.trio[2].modelId,
      1_000_000,
      1_000_000,
    );

    const response = await send(org, {
      ingress: "chat",
      path: "chat/completions",
      session: "s-1",
    });

    expect(response.statusCode, response.body).toBe(402);
    expect(response.json().error).toMatchObject({
      type: "usage_limit_exceeded",
      code: "token_cost_limit_exceeded",
      usage_limit: { entity_type: "virtual_key", limit_type: "token_cost" },
    });
    expect(jevCalls).toBe(0);
    expect(await decisions(org.organizationId)).toEqual([]);
    expect(upstreamModels).toEqual([]);
  });

  test("routes to the normal tier without a decision when there is nothing to key on", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    await publishPlan(org);

    const response = await send(org, {
      ingress: "chat",
      path: "chat/completions",
      session: null,
      messages: [{ role: "system", content: "No user turn" }],
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(upstreamModels).toEqual([org.trio[1].modelId]);
    expect(await decisions(org.organizationId)).toEqual([]);
    expect(jevCalls).toBe(0);
  });

  test("a session without a client id is logged under its routing key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });

    const response = await send(org, {
      ingress: "chat",
      path: "chat/completions",
      session: null,
    });

    expect(response.statusCode, response.body).toBe(200);
    const [decision] = await decisions(org.organizationId);
    const rows = await db
      .select({
        sessionId: schema.interactionsTable.sessionId,
        sessionSource: schema.interactionsTable.sessionSource,
      })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, org.agentId));
    expect(rows).toEqual([
      { sessionId: decision.sessionKey, sessionSource: "auto_routing" },
    ]);
  });

  test("a Responses continuation without a session id is refused before routing", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    await publishPlan(org);
    const continuation = {
      ingress: "responses",
      path: "responses",
      extra: { previous_response_id: "resp-earlier" },
    } as const;

    const unnamed = await send(org, { ...continuation, session: null });
    const named = await send(org, { ...continuation, session: "s-1" });

    expect(unnamed.statusCode, unnamed.body).toBe(400);
    expect(named.statusCode, named.body).toBe(200);
    expect(upstreamModels).toEqual([org.trio[2].modelId]);
    expect(await decisions(org.organizationId)).toHaveLength(1);
  });

  for (const scopedTier of [0, 2] as const) {
    test(`auto checks the selected tier, not the incoming alias or unrelated tier ${scopedTier}`, async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await publishPlan(org);
      await LimitModel.create({
        entityType: "organization",
        entityId: org.organizationId,
        limitType: "token_cost",
        limitValue: 0,
        model: [org.trio[scopedTier].modelId],
        lastCleanup: new Date(),
      });

      const response = await send(org, {
        ingress: "chat",
        path: "chat/completions",
        session: "scoped-budget",
      });

      expect(response.statusCode, response.body).toBe(
        scopedTier === 2 ? 402 : 200,
      );
      expect(jevCalls).toBe(1);
      expect(upstreamModels).toEqual(
        scopedTier === 2 ? [] : [org.trio[2].modelId],
      );
      expect(await decisions(org.organizationId)).toHaveLength(1);
    });
  }

  test("auto wins over a model pool of the same name", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    config.llmProxy.modelPoolsEnabled = true;
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    await publishPlan(org);
    // Pools named "auto" are refused on create; one may predate the alias.
    await ModelPoolModel.create({
      organizationId: org.organizationId,
      input: {
        name: "auto",
        members: [
          {
            providerApiKeyId: org.providerApiKeyId,
            modelId: "pool-member",
            priority: 1,
            weight: 1,
            enabled: true,
          },
        ],
      },
    });

    const response = await send(org, {
      ingress: "chat",
      path: "chat/completions",
      session: "s-1",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(upstreamModels).toEqual([org.trio[2].modelId]);
    expect(await decisions(org.organizationId)).toHaveLength(1);
  });

  test("a plan fitted by the plan fit routes the next session as planned", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    config.autoRouting.minSessions = 30;
    await AutoRoutingSettingsModel.update(org.organizationId, {
      budgetUsdPerDay: "10000.00",
    });
    await seedFitHistory({
      organizationId: org.organizationId,
      modelId: org.trio[2].id,
      scorerVersionId: (await activeSourceVersion()).id,
      sessions: 40,
    });

    await handleAutoRoutingFit({ organizationId: org.organizationId });
    const response = await send(org, {
      ingress: "chat",
      path: "chat/completions",
      session: "fresh-session",
    });

    expect(response.statusCode, response.body).toBe(200);
    const plan = await RoutingPlanModel.findActive(org.organizationId);
    expect(
      await RoutingDecisionModel.find({
        organizationId: org.organizationId,
        sessionKey: RoutingSessionKeySchema.parse("fresh-session"),
      }),
    ).toMatchObject({ reason: "planned", planId: plan?.id });
  });

  test("a plan the router rejects falls back and requests a re-plan", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    await publishPlan(org, (plan) => ({
      ...plan,
      versions: { ...plan.versions, plan_format_version: 999 },
    }));
    const before = await AutoRoutingSettingsModel.find(org.organizationId);

    const response = await send(org, {
      ingress: "chat",
      path: "chat/completions",
      session: "s-1",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(upstreamModels).toEqual([org.trio[1].modelId]);
    expect(await decisions(org.organizationId)).toEqual([
      expect.objectContaining({ reason: "plan_stale", planId: null }),
    ]);
    const after = await AutoRoutingSettingsModel.find(org.organizationId);
    expect(after?.generation).toBeGreaterThan(before?.generation ?? 0);
  });

  describe("tier eligibility", () => {
    test("an unlinked tier is refused before scoring and hides auto", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await unlink(org, org.trio[0]);

      await expectRefused(org, "fast");
      expect(await listsAuto(org)).toBe(false);
      expect(jevCalls).toBe(0);
    });

    test("a tier without a use grant for the credential is refused", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const someone = await makeUser();
      await grantOnly(org, org.trio[2], [
        { subject: { type: "user", id: someone.id }, actions: ["read", "use"] },
      ]);

      await expectRefused(org, "smart");
      expect(await listsAuto(org)).toBe(false);
      expect(jevCalls).toBe(0);
    });

    test("a tier the endpoint cannot serve is refused on that endpoint only", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
        supportedEndpoints: { 1: ["/responses"] },
      });

      await expectRefused(org, "normal", "chat");
      const responses = await send(org, {
        ingress: "responses",
        path: "responses",
        session: "s-1",
      });
      expect(responses.statusCode, responses.body).toBe(200);
      expect(await listsAuto(org)).toBe(true);
    });

    test("a user grant admits that user's personal key but not a service account", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeServiceAccount,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const owner = await makeUser();
      await db.insert(schema.membersTable).values({
        id: crypto.randomUUID(),
        userId: owner.id,
        organizationId: org.organizationId,
        role: MEMBER_ROLE_NAME,
        createdAt: new Date(),
      });
      for (const model of org.trio) {
        await grantOnly(org, model, [
          { subject: { type: "user", id: owner.id }, actions: ["read", "use"] },
        ]);
      }
      const personal = await virtualKey(org, { authorId: owner.id });
      const account = await makeServiceAccount(org.organizationId);
      const serviceAccount = await virtualKey(org, {
        authorId: serviceAccountUserId(account.id),
      });

      const allowed = await send(
        { ...org, credential: personal },
        { ingress: "chat", path: "chat/completions", session: "s-1" },
      );
      const refused = await send(
        { ...org, credential: serviceAccount },
        { ingress: "chat", path: "chat/completions", session: "s-2" },
      );

      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.message).toContain("fast tier");
      expect(await listsAuto({ ...org, credential: personal })).toBe(true);
      expect(await listsAuto({ ...org, credential: serviceAccount })).toBe(
        false,
      );
    });

    test("a per-user credential behind an organization key is refused", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const owner = await makeUser();
      const copilotModel = await createModel("github-copilot", "gpt-4o");
      const secret = await makeSecret({ secret: { apiKey: "gho_copilot" } });
      const copilotKey = await makeLlmProviderApiKey(
        org.organizationId,
        secret.id,
        { provider: "github-copilot", userId: owner.id },
      );
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(copilotKey.id, [
        copilotModel.id,
      ]);
      await setOrganizationTrio(org.organizationId, { smart: copilotModel });
      const credential = await virtualKey(org, {
        authorId: null,
        extraKeys: [
          { provider: "github-copilot", providerApiKeyId: copilotKey.id },
        ],
      });

      await expectRefused({ ...org, credential }, "smart");
      expect(await listsAuto({ ...org, credential })).toBe(false);
      expect(jevCalls).toBe(0);
    });

    test("a tier on a provider the Model Router cannot serve is refused", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const nativeModel = await createModel("ollama-native", "llama3.2");
      const secret = await makeSecret({ secret: { apiKey: "ollama" } });
      const nativeKey = await makeLlmProviderApiKey(
        org.organizationId,
        secret.id,
        { provider: "ollama-native" },
      );
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(nativeKey.id, [
        nativeModel.id,
      ]);
      await setOrganizationTrio(org.organizationId, { normal: nativeModel });
      const credential = await virtualKey(org, {
        authorId: null,
        extraKeys: [
          { provider: "ollama-native", providerApiKeyId: nativeKey.id },
        ],
      });

      await expectRefused({ ...org, credential }, "normal");
      await expectRefused({ ...org, credential }, "normal", "responses");
      expect(await listsAuto({ ...org, credential })).toBe(false);
      expect(jevCalls).toBe(0);
      expect(await decisions(org.organizationId)).toEqual([]);
    });

    test("tiers sharing a credential read its secret once per request", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const reads = vi.spyOn(secretManager(), "getSecret");
      const providerReads = () =>
        reads.mock.calls.filter(([id]) => id === org.providerSecretId).length;

      const response = await send(org, {
        ingress: "chat",
        path: "chat/completions",
        session: "s-1",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(upstreamModels).toEqual([org.trio[1].modelId]);
      expect(providerReads()).toBe(1);

      await send(org, {
        ingress: "chat",
        path: "chat/completions",
        session: "s-1",
      });
      expect(providerReads()).toBe(2);
      reads.mockRestore();
    });
  });

  describe("listing", () => {
    test("lists auto exactly when inference accepts it", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });

      expect(await listsAuto(org)).toBe(true);
      const accepted = await send(org, {
        ingress: "chat",
        path: "chat/completions",
        session: "s-1",
      });
      expect(accepted.statusCode, accepted.body).toBe(200);

      await AutoRoutingSettingsModel.update(org.organizationId, {
        enabled: false,
      });
      expect(await listsAuto(org)).toBe(false);
      const refused = await send(org, {
        ingress: "chat",
        path: "chat/completions",
        session: "s-2",
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.message).toContain("not enabled");
    });
  });

  test("with the feature off, auto is neither listed nor routed", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    config.autoRouting.enabled = false;

    const response = await send(org, {
      ingress: "chat",
      path: "chat/completions",
      session: "s-1",
    });

    expect(response.statusCode).toBe(404);
    expect(await listsAuto(org)).toBe(false);
    expect(await decisions(org.organizationId)).toEqual([]);
  });

  test("native provider routes refuse auto", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await setupOrganization({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const app = createApp();
    await app.register(openAiProxyRoutes);

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${org.agentId}/chat/completions`,
      headers: { authorization: "Bearer sk-native" },
      payload: { model: "auto", messages: [{ role: "user", content: PROMPT }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "only available through the Model Router",
    );
    expect(upstreamModels).toEqual([]);
  });

  describe("a platform call on the organization default, on the native route", () => {
    async function sendPlatformCall(
      org: Org,
      params: {
        userId: string;
        agentId?: string;
        model?: string;
        routable?: boolean;
        internal?: boolean;
        /** The key the call names; the organization's shared key by default. */
        callKeyId?: string;
        stream?: boolean;
      },
    ) {
      const app = createApp();
      await app.register(openAiProxyRoutes);
      return app.inject({
        method: "POST",
        url: `/v1/openai/${params.agentId ?? org.agentId}/chat/completions`,
        remoteAddress: "127.0.0.1",
        headers: {
          ...(params.internal === false ? {} : internalCallHeader()),
          authorization: "Bearer sk-openai",
          [CHAT_API_KEY_ID_HEADER]: params.callKeyId ?? org.providerApiKeyId,
          [USER_ID_HEADER]: params.userId,
          [PROVIDER_BASE_URL_HEADER]: UPSTREAM,
          "x-archestra-session-id": "chat-1",
          ...(params.routable === false
            ? {}
            : { [AUTO_ROUTABLE_HEADER]: "true" }),
        },
        payload: {
          // The organization default model, auto routing's normal tier.
          model: params.model ?? org.trio[1].modelId,
          messages: [{ role: "user", content: PROMPT }],
          ...(params.stream ? { stream: true } : {}),
        },
      });
    }

    async function member(
      org: Org,
      makeUser: () => Promise<{ id: string }>,
      makeMember: (userId: string, organizationId: string) => Promise<unknown>,
    ) {
      const user = await makeUser();
      await makeMember(user.id, org.organizationId);
      return user.id;
    }

    test("an agent inheriting the default runs on the session's routed tier while routing is on", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await publishPlan(org);
      const userId = await member(org, makeUser, makeMember);
      const agent = await makeAgent({
        organizationId: org.organizationId,
        agentType: "agent",
      });

      const first = await sendPlatformCall(org, { userId, agentId: agent.id });
      const replay = await sendPlatformCall(org, { userId, agentId: agent.id });

      expect(first.statusCode, first.body).toBe(200);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(upstreamModels).toEqual([
        org.trio[2].modelId,
        org.trio[2].modelId,
      ]);
      expect(jevCalls).toBe(1);
      const [decision] = await decisions(org.organizationId);
      expect(decision).toMatchObject({ tierIndex: 2, modelId: org.trio[2].id });
      expect(await usage(decision.id)).toHaveLength(2);
      const rows = await db
        .select({
          model: schema.interactionsTable.model,
          providerApiKeyId: schema.interactionsTable.providerApiKeyId,
        })
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, agent.id));
      expect(rows).toEqual(
        [1, 2].map(() => ({
          model: org.trio[2].modelId,
          providerApiKeyId: org.providerApiKeyId,
        })),
      );
    });

    test("with routing off, an agent inheriting the default runs on the default model", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await publishPlan(org);
      await AutoRoutingSettingsModel.update(org.organizationId, {
        enabled: false,
      });
      const userId = await member(org, makeUser, makeMember);

      const response = await sendPlatformCall(org, { userId });

      expect(response.statusCode, response.body).toBe(200);
      expect(upstreamModels).toEqual([org.trio[1].modelId]);
      expect(jevCalls).toBe(0);
      expect(await decisions(org.organizationId)).toEqual([]);
    });

    test("an agent with its own model, pool or runtime is never routed", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await publishPlan(org);
      const userId = await member(org, makeUser, makeMember);
      const pool = await ModelPoolModel.create({
        organizationId: org.organizationId,
        input: {
          name: `pool-${crypto.randomUUID().slice(0, 8)}`,
          members: [
            {
              providerApiKeyId: org.providerApiKeyId,
              modelId: org.trio[1].modelId,
              priority: 1,
              weight: 1,
              enabled: true,
            },
          ],
        },
      });
      const agents = await Promise.all([
        makeAgent({
          organizationId: org.organizationId,
          agentType: "agent",
          llmApiKeyId: org.providerApiKeyId,
          modelId: org.trio[1].id,
        }),
        makeAgent({
          organizationId: org.organizationId,
          agentType: "agent",
          modelPoolId: pool.id,
        }),
        makeAgent({
          organizationId: org.organizationId,
          agentType: "agent",
          runtime: {
            image: "test:local",
            command: null,
            inferenceProtocol: "openai_responses",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: 24,
            idleTimeoutMinutes: 5,
          },
        }),
      ]);

      for (const agent of agents) {
        const response = await sendPlatformCall(org, {
          userId,
          agentId: agent.id,
        });
        expect(response.statusCode, response.body).toBe(200);
      }

      expect(upstreamModels).toEqual(agents.map(() => org.trio[1].modelId));
      expect(jevCalls).toBe(0);
      expect(await decisions(org.organizationId)).toEqual([]);
    });

    test("an explicit tier, another model, or a call without the internal proof runs on the model it names", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await publishPlan(org);
      const userId = await member(org, makeUser, makeMember);

      // A subagent fork that asked for a tier is not marked routable.
      const explicitTier = await sendPlatformCall(org, {
        userId,
        model: org.trio[0].modelId,
        routable: false,
      });
      const otherModel = await sendPlatformCall(org, {
        userId,
        model: org.trio[2].modelId,
      });
      // Without the internal proof the header means nothing; the call goes to
      // the provider's own endpoint, which this test does not serve.
      await sendPlatformCall(org, { userId, internal: false });

      expect(explicitTier.statusCode, explicitTier.body).toBe(200);
      expect(otherModel.statusCode, otherModel.body).toBe(200);
      expect(upstreamModels).toEqual([
        org.trio[0].modelId,
        org.trio[2].modelId,
      ]);
      expect(jevCalls).toBe(0);
      expect(await decisions(org.organizationId)).toEqual([]);
    });

    test("a limit on the routed tier's model applies to the call, not the default's", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await publishPlan(org);
      const userId = await member(org, makeUser, makeMember);
      const smartOnly = await LimitModel.create({
        entityType: "organization",
        entityId: org.organizationId,
        limitType: "requests",
        cleanupInterval: "calendar_day",
        limitValue: 1,
        model: [org.trio[2].modelId],
      });
      const spent = await LlmThroughputModel.admit({
        entities: [
          { entityType: "organization", entityId: org.organizationId },
        ],
        model: org.trio[2].modelId,
      });
      expect("reservation" in spent && spent.reservation).toBeTruthy();

      const plain = await sendPlatformCall(org, { userId, routable: false });
      const routed = await sendPlatformCall(org, { userId });

      expect(plain.statusCode, plain.body).toBe(200);
      expect(routed.statusCode, routed.body).toBe(429);
      expect(upstreamModels).toEqual([org.trio[1].modelId]);
      expect(
        (await LlmThroughputModel.usage([smartOnly])).get(smartOnly.id)
          ?.currentUsage,
      ).toBe(1);
    });

    for (const scopedTier of [1, 2] as const) {
      test(`a budget on tier ${scopedTier}'s model applies to the calls that run on it`, async ({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
        makeUser,
        makeMember,
      }) => {
        const org = await setupOrganization({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
        });
        await publishPlan(org);
        const userId = await member(org, makeUser, makeMember);
        await LimitModel.create({
          entityType: "organization",
          entityId: org.organizationId,
          limitType: "token_cost",
          limitValue: 0,
          model: [org.trio[scopedTier].modelId],
          lastCleanup: new Date(),
        });

        const plain = await sendPlatformCall(org, { userId, routable: false });
        const routed = await sendPlatformCall(org, { userId });

        expect(plain.statusCode, plain.body).toBe(scopedTier === 1 ? 402 : 200);
        expect(routed.statusCode, routed.body).toBe(
          scopedTier === 2 ? 402 : 200,
        );
        expect(upstreamModels).toEqual(
          scopedTier === 2 ? [org.trio[1].modelId] : [org.trio[2].modelId],
        );
        expect(await decisions(org.organizationId)).toHaveLength(1);
      });
    }

    test("a routed stream is kept alive while the tier is silent before its first event", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    }) => {
      const interval = config.llmProxy.streamKeepAliveIntervalMs;
      onTestFinished(() => {
        config.llmProxy.streamKeepAliveIntervalMs = interval;
      });
      config.llmProxy.streamKeepAliveIntervalMs = 20;
      server.use(
        http.post(`${UPSTREAM}/chat/completions`, async ({ request }) => {
          const body = (await request.json()) as { model: string };
          upstreamModels.push(body.model);
          const chunk = {
            id: "chatcmpl-auto",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Done" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 1,
              total_tokens: 13,
            },
          };
          const encoder = new TextEncoder();
          return new HttpResponse(
            new ReadableStream({
              async start(controller) {
                await delay(200);
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                  ),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await publishPlan(org);
      const userId = await member(org, makeUser, makeMember);

      const response = await sendPlatformCall(org, { userId, stream: true });

      expect(response.statusCode, response.body).toBe(200);
      expect(upstreamModels).toEqual([org.trio[2].modelId]);
      const keepAlive = response.body.indexOf(STREAM_KEEPALIVE_SSE_COMMENT);
      expect(keepAlive).toBeGreaterThanOrEqual(0);
      expect(keepAlive).toBeLessThan(response.body.indexOf("data:"));
    });

    test("a tier served only on the Responses API keeps the call on the default model, undecided", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
        supportedEndpoints: { 2: ["/responses"] },
      });
      await publishPlan(org);
      const userId = await member(org, makeUser, makeMember);

      const response = await sendPlatformCall(org, { userId });

      expect(response.statusCode, response.body).toBe(200);
      expect(upstreamModels).toEqual([org.trio[1].modelId]);
      expect(jevCalls).toBe(0);
      expect(await decisions(org.organizationId)).toEqual([]);
    });

    test("a session routed to a model that left the trio and the user's reach runs on normal", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await publishPlan(org);
      const userId = await member(org, makeUser, makeMember);
      const first = await sendPlatformCall(org, { userId });
      expect(first.statusCode, first.body).toBe(200);

      const replacement = await createModel(
        "openai",
        `smart-${crypto.randomUUID()}`,
      );
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
        org.providerApiKeyId,
        [replacement.id],
      );
      await setOrganizationTrio(org.organizationId, { smart: replacement });
      await unlink(org, org.trio[2]);
      const replay = await sendPlatformCall(org, { userId });

      expect(replay.statusCode, replay.body).toBe(200);
      expect(upstreamModels).toEqual([
        org.trio[2].modelId,
        org.trio[1].modelId,
      ]);
      const stored = await decisions(org.organizationId);
      expect(stored).toEqual([
        expect.objectContaining({ modelId: org.trio[2].id }),
      ]);
      expect(await usage(stored[0].id)).toHaveLength(1);
    });

    test("a tier only a lower-ranked key of the user serves is sent on that key", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      await publishPlan(org);
      const userId = await member(org, makeUser, makeMember);
      // The personal key ranks above the shared one but serves no smart tier.
      const personal = await personalKey(
        org,
        userId,
        [org.trio[0], org.trio[1]],
        {
          makeSecret,
          makeLlmProviderApiKey,
        },
      );

      const response = await sendPlatformCall(org, {
        userId,
        callKeyId: personal,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(upstreamModels).toEqual([org.trio[2].modelId]);
      expect(await platformCalls(org.agentId)).toEqual([
        { model: org.trio[2].modelId, providerApiKeyId: org.providerApiKeyId },
      ]);
    });

    test("a call on the organization's key stays on it for a tier it serves, though the user's own key ranks first", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    }) => {
      const org = await setupOrganization({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const userId = await member(org, makeUser, makeMember);
      await personalKey(org, userId, org.trio, {
        makeSecret,
        makeLlmProviderApiKey,
      });

      const response = await sendPlatformCall(org, { userId });

      expect(response.statusCode, response.body).toBe(200);
      expect(await platformCalls(org.agentId)).toEqual([
        { model: org.trio[1].modelId, providerApiKeyId: org.providerApiKeyId },
      ]);
    });

    for (const [label, tier] of [
      ["a provider the client's wire cannot reach", "gemini"],
      ["a per-user provider", "github-copilot"],
    ] as const) {
      test(`a tier on ${label} keeps the call on the default model, undecided`, async ({
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
        makeUser,
        makeMember,
      }) => {
        const org = await setupOrganization({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
        });
        await publishPlan(org);
        const userId = await member(org, makeUser, makeMember);
        await setOrganizationTrio(org.organizationId, {
          smart: await createModel(tier, `smart-${crypto.randomUUID()}`),
        });

        const response = await sendPlatformCall(org, { userId });

        expect(response.statusCode, response.body).toBe(200);
        expect(upstreamModels).toEqual([org.trio[1].modelId]);
        expect(jevCalls).toBe(0);
        expect(await decisions(org.organizationId)).toEqual([]);
      });
    }
  });
});

// === Helpers ===

type RouterPlan = { versions: Record<string, unknown> } & Record<
  string,
  unknown
>;

type MakeSecret = (params: {
  secret: Record<string, unknown>;
}) => Promise<{ id: string }>;
type MakeLlmProviderApiKey = (
  organizationId: string,
  secretId: string,
  overrides?: {
    provider?: Model["provider"];
    baseUrl?: string | null;
    userId?: string | null;
  },
) => Promise<{ id: string }>;

async function createModel(
  provider: Model["provider"],
  modelId: string,
  prices: { input: string; output: string } = { input: "1.00", output: "5.00" },
  supportedEndpoints?: string[],
) {
  return ModelModel.create({
    externalId: `${provider}/${modelId}`,
    provider,
    modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    customPricePerMillionInput: prices.input,
    customPricePerMillionOutput: prices.output,
    supportedEndpoints: supportedEndpoints as Model["supportedEndpoints"],
  });
}

async function setupOrganization(params: {
  makeOrganization: () => Promise<{ id: string }>;
  makeSecret: MakeSecret;
  makeLlmProviderApiKey: MakeLlmProviderApiKey;
  supportedEndpoints?: Partial<Record<0 | 1 | 2, string[]>>;
}) {
  const organizationId = (await params.makeOrganization()).id;
  const agent = await AgentModel.getOrgLlmProxy(organizationId);
  const suffix = crypto.randomUUID().slice(0, 8);
  const trio = [
    await createModel(
      "openai",
      `fast-${suffix}`,
      { input: "1.00", output: "5.00" },
      params.supportedEndpoints?.[0],
    ),
    await createModel(
      "openai",
      `normal-${suffix}`,
      { input: "3.00", output: "15.00" },
      params.supportedEndpoints?.[1],
    ),
    await createModel(
      "openai",
      `smart-${suffix}`,
      { input: "15.00", output: "75.00" },
      params.supportedEndpoints?.[2],
    ),
  ] as const satisfies Trio;

  const jevSecret = await params.makeSecret({ secret: { apiKey: "sk-jev" } });
  await params.makeLlmProviderApiKey(organizationId, jevSecret.id, {
    provider: "jev",
  });
  const secret = await params.makeSecret({ secret: { apiKey: "sk-openai" } });
  const providerApiKey = await params.makeLlmProviderApiKey(
    organizationId,
    secret.id,
    { provider: "openai", baseUrl: UPSTREAM },
  );
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
    providerApiKey.id,
    trio.map((model) => model.id),
  );
  await setOrganizationTrio(organizationId, {
    fast: trio[0],
    normal: trio[1],
    smart: trio[2],
  });
  await AutoRoutingSettingsModel.update(organizationId, { enabled: true });
  const base = {
    organizationId,
    agentId: agent.id,
    trio,
    providerApiKeyId: providerApiKey.id,
  };
  return {
    ...base,
    providerSecretId: secret.id,
    credential: await virtualKey(base, { authorId: null }),
  };
}

async function virtualKey(
  org: { organizationId: string; providerApiKeyId: string },
  params: {
    authorId: string | null;
    extraKeys?: { provider: Model["provider"]; providerApiKeyId: string }[];
  },
): Promise<string> {
  const { value } = await VirtualApiKeyModel.create({
    organizationId: org.organizationId,
    name: `auto-${crypto.randomUUID().slice(0, 8)}`,
    authorId: params.authorId,
    ...accessGrants(params.authorId ? "personal" : "org"),
    providerApiKeys: [
      { provider: "openai", providerApiKeyId: org.providerApiKeyId },
      ...(params.extraKeys ?? []),
    ],
  });
  return value;
}

/** Fits a real plan for the trio over synthetic history and publishes it. */
async function publishPlan(
  org: Org,
  edit: (plan: RouterPlan) => RouterPlan = (plan) => plan,
  scorerVersionId?: string,
) {
  const scorer = { id: scorerVersionId ?? (await activeSourceVersion()).id };
  await AutoRoutingSettingsModel.activateScorerVersion(
    org.organizationId,
    scorer.id,
  );
  const settings = await AutoRoutingSettingsModel.find(org.organizationId);
  if (!settings) throw new Error("organization has no LLM Proxy");
  const fingerprint = tiersFingerprint(org.trio);
  const features = {
    tier_needed: [0.4, 0.3, 0.3],
    p_long: 0,
    source: "unknown",
  };
  const planJson = await fitPlan(
    JSON.stringify({
      history: Array.from({ length: 40 }, (_, i) => ({
        features,
        short: {
          input: 1_000 + 37 * i,
          cache_read: 20_000 + 101 * i,
          cache_write: 2_000,
          output: 500 + 11 * i,
        },
        long: { input: 0, cache_read: 0, cache_write: 0, output: 0 },
        timestamp_ms: i * 86_400_000,
        weight: 1,
      })),
      tiers: fingerprint,
      budget: 10_000,
      volume: { kind: "flat", sessions_per_day: 40, tokens_per_day: 1e6 },
      baseline_source: "unknown",
    }),
  );
  const published = await RoutingPlanModel.publish({
    organizationId: org.organizationId,
    trigger: "manual",
    generation: settings.generation,
    inputWatermark: new Date(),
    tiersFingerprint: fingerprint,
    budgetUsdPerDay: "10000",
    scorerVersionId: scorer.id,
    coreVersion: "0.1.0",
    planFormatVersion: 1,
    outcome: {
      status: "active",
      plan: edit(JSON.parse(planJson)),
      summary: null,
      diagnostics: null,
    },
  });
  if (published.kind !== "recorded") throw new Error("plan was not published");
  return published.plan;
}

/** A personal OpenAI key of `userId` on the test upstream, linked to `models`. */
async function personalKey(
  org: Org,
  userId: string,
  models: readonly Model[],
  fixtures: {
    makeSecret: MakeSecret;
    makeLlmProviderApiKey: MakeLlmProviderApiKey;
  },
): Promise<string> {
  const secret = await fixtures.makeSecret({
    secret: { apiKey: "sk-personal" },
  });
  const key = await fixtures.makeLlmProviderApiKey(
    org.organizationId,
    secret.id,
    { provider: "openai", baseUrl: UPSTREAM, userId },
  );
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
    key.id,
    models.map((model) => model.id),
  );
  return key.id;
}

/** The model and key each platform call on `agentId` was sent with. */
function platformCalls(agentId: string) {
  return db
    .select({
      model: schema.interactionsTable.model,
      providerApiKeyId: schema.interactionsTable.providerApiKeyId,
    })
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.profileId, agentId));
}

async function unlink(org: Org, model: Model) {
  await db
    .delete(schema.llmProviderApiKeyModelsTable)
    .where(
      and(
        eq(schema.llmProviderApiKeyModelsTable.apiKeyId, org.providerApiKeyId),
        eq(schema.llmProviderApiKeyModelsTable.modelId, model.id),
      ),
    );
}

async function grantOnly(
  org: Org,
  model: Model,
  grants: ResourcePermissionGrant[],
) {
  const key = {
    organizationId: org.organizationId,
    resource: "llmModel" as const,
    scope: model.id,
  };
  const current = await ResourcePermissionPolicyModel.find(key);
  const saved = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: current?.revision ?? 0,
    grants,
  });
  if (!saved) throw new Error("failed to write model grants");
}

function createApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.statusCode)
        .send({ error: { message: error.message, type: error.type } });
    }
    return reply.status(500).send({
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "api_internal_server_error",
      },
    });
  });
  return app;
}

async function send(
  org: Pick<Org, "agentId" | "credential">,
  params: {
    ingress: Ingress;
    path: string;
    session: string | null;
    prompt?: string;
    messages?: { role: string; content: string }[];
    extra?: Record<string, unknown>;
  },
) {
  const app = createApp();
  await app.register(modelRouterProxyRoutes);
  const messages = params.messages ?? [
    { role: "user", content: params.prompt ?? PROMPT },
  ];
  return app.inject({
    method: "POST",
    url: `/v1/model-router/${org.agentId}/${params.path}`,
    headers: {
      authorization: `Bearer ${org.credential}`,
      ...(params.session ? { "x-archestra-session-id": params.session } : {}),
    },
    payload: {
      model: "auto",
      ...(params.ingress === "chat" ? { messages } : { input: messages }),
      ...params.extra,
    },
  });
}

async function expectRefused(
  org: Pick<Org, "agentId" | "credential">,
  tier: "fast" | "normal" | "smart",
  ingress: Ingress = "chat",
) {
  const response = await send(org, {
    ingress,
    path: ingress === "chat" ? "chat/completions" : "responses",
    session: "s-refused",
  });
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json().error.message).toContain(`${tier} tier`);
}

async function listsAuto(org: Pick<Org, "agentId" | "credential">) {
  const app = createApp();
  await app.register(modelRouterProxyRoutes);
  const response = await app.inject({
    method: "GET",
    url: `/v1/model-router/${org.agentId}/models`,
    headers: { authorization: `Bearer ${org.credential}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json().data as { id: string }[]).some(
    (model) => model.id === "auto",
  );
}

async function decisions(organizationId: string): Promise<RoutingDecision[]> {
  return (await db
    .select()
    .from(schema.routingDecisionsTable)
    .where(
      eq(schema.routingDecisionsTable.organizationId, organizationId),
    )) as RoutingDecision[];
}

function usage(decisionId: string) {
  return db
    .select()
    .from(schema.routingUsageTable)
    .where(eq(schema.routingUsageTable.decisionId, decisionId));
}

function chatCompletion(model: string) {
  return {
    id: "chatcmpl-auto",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Done", refusal: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
  };
}

function responsesResponse(model: string) {
  return {
    id: "resp-auto",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [
      {
        id: "msg-auto",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Done", annotations: [] }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 10, total_tokens: 22 },
  };
}
