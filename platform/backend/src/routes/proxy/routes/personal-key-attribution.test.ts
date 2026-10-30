import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import EnvironmentDefaultUserLimitModel from "@/models/environment-default-user-limit";
import LimitModel from "@/models/limit";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
import openAiProxyRoutes from "./openai";

// Only the provider HTTP boundary is simulated. Key authentication, identity
// resolution, limit admission, interaction persistence, and spend updates run
// against the real application and database code.
describe("personal standard key attribution", () => {
  setupTestCacheManager();
  const upstream = useMswServer();
  let app: ReturnType<typeof createFastifyInstance>;
  let organizationId: string;
  let agentId: string;
  let owner: { id: string; email: string };
  let other: { id: string; email: string };
  let credential: string;
  let virtualKeyId: string;
  let providerKeyId: string;
  let providerCalls: number;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      organizationId = org.id;
      owner = await makeUser({ email: "owner@example.com" });
      other = await makeUser({ email: "other@example.com" });
      await makeMember(owner.id, org.id);
      await makeMember(other.id, org.id);
      const agent = await makeAgent({ organizationId, access: "org" });
      agentId = agent.id;
      const secret = await makeSecret({
        secret: { apiKey: "synthetic-provider-credential" },
      });
      const provider = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
        baseUrl: "https://provider.example/v1",
      });
      providerKeyId = provider.id;
      const key = await VirtualApiKeyModel.create({
        organizationId,
        name: "Personal attribution key",
        scope: "personal",
        authorId: owner.id,
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: providerKeyId },
        ],
      });
      credential = key.value;
      virtualKeyId = key.virtualKey.id;
      await ModelModel.create({
        externalId: "openai/gpt-4o",
        inputModalities: ["text"],
        outputModalities: ["text"],
        provider: "openai",
        modelId: "gpt-4o",
        customPricePerMillionInput: "2.50",
        customPricePerMillionOutput: "10.00",
      });
      providerCalls = 0;
      upstream.use(
        http.post("https://provider.example/v1/chat/completions", () => {
          providerCalls++;
          return HttpResponse.json({
            id: "chatcmpl-attribution",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
          });
        }),
      );
      app = createFastifyInstance();
      await app.register(openAiProxyRoutes);
    },
  );

  afterEach(async () => {
    await drainBackgroundWork();
    await app?.close();
  });

  const call = (headers: Record<string, string> = {}, token = credential) =>
    app.inject({
      method: "POST",
      url: `/v1/openai/${agentId}/chat/completions`,
      remoteAddress: "203.0.113.5",
      headers: { authorization: `Bearer ${token}`, ...headers },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

  const hints = (): Record<string, string>[] => [
    {},
    { "x-archestra-user-id": owner.id },
    { "x-archestra-user-id": other.id },
    { "x-openwebui-user-email": other.email },
    { "x-archestra-user-id": other.id, "x-openwebui-user-email": other.email },
  ];

  for (const source of ["custom", "default"] as const) {
    test(`${source} owner limit cannot be bypassed with identity hints`, async ({
      makeInteraction,
    }) => {
      if (source === "custom") {
        await LimitModel.create({
          entityType: "user",
          entityId: owner.id,
          limitType: "token_cost",
          limitValue: 1,
          model: ["gpt-4o"],
          lastCleanup: new Date(),
        });
        await LimitModel.updateTokenLimitUsage(
          "user",
          owner.id,
          "gpt-4o",
          1000000,
          1000000,
        );
      } else {
        await EnvironmentDefaultUserLimitModel.create({
          organizationId,
          environmentId: null,
          limitValue: 1,
          model: ["gpt-4o"],
          cleanupInterval: "1w",
        });
        await makeInteraction(agentId, {
          userId: owner.id,
          model: "gpt-4o",
          cost: "2",
        });
      }
      for (const headers of hints()) {
        const response = await call(headers);
        expect(response.statusCode, response.body).toBe(402);
        expect(response.json().error.usage_limit).toMatchObject({
          entity_type: "user",
          entity_name: owner.email,
          ...(source === "default" ? { source: "default_user" } : {}),
        });
      }
      expect(providerCalls).toBe(0);
      // A second personal key can still use the same agent and provider.
      const otherKey = await VirtualApiKeyModel.create({
        organizationId,
        name: "Other personal key",
        scope: "personal",
        authorId: other.id,
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: providerKeyId },
        ],
      });
      const control = await call(
        { "x-archestra-user-id": owner.id },
        otherKey.value,
      );
      expect(control.statusCode, control.body).toBe(200);
      expect(providerCalls).toBe(1);
    });
  }

  test("logs, personal spend and key usage stay with the owner", async () => {
    const limits = await Promise.all(
      [
        { entityType: "user" as const, entityId: owner.id },
        { entityType: "user" as const, entityId: other.id },
        { entityType: "virtual_key" as const, entityId: virtualKeyId },
      ].map((entity) =>
        LimitModel.create({
          ...entity,
          limitType: "token_cost",
          limitValue: 10,
          model: ["gpt-4o"],
          lastCleanup: new Date(),
        }),
      ),
    );
    for (const headers of hints()) {
      const response = await call(headers);
      expect(response.statusCode, response.body).toBe(200);
    }
    await drainBackgroundWork();
    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, agentId));
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toMatchObject({
        userId: owner.id,
        virtualKeyId,
        authMethod: "virtual_key",
        billingTeamId: null,
      });
      expect(Number(row.cost)).toBeCloseTo(0.00045, 8);
    }
    for (const [index, limit] of limits.entries()) {
      expect(await LimitModel.getRawModelUsage(limit.id)).toMatchObject([
        {
          currentUsageTokensIn: index === 1 ? 0 : 500,
          currentUsageTokensOut: index === 1 ? 0 : 100,
        },
      ]);
    }
    const spend = await LimitModel.getDefaultUserLimitUsageByUser({
      organizationId,
      models: ["gpt-4o"],
      cleanupInterval: "1w",
    });
    expect(spend.get(owner.id)?.cost).toBeCloseTo(0.00225, 8);
    expect(spend.get(other.id)).toBeUndefined();
  });

  test("an org key still accepts integration attribution hints", async () => {
    const key = await VirtualApiKeyModel.create({
      organizationId,
      name: "Integration key",
      scope: "org",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKeyId },
      ],
    });
    const response = await call(
      { "x-openwebui-user-email": other.email },
      key.value,
    );
    expect(response.statusCode, response.body).toBe(200);
    const [row] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, agentId));
    expect(row.userId).toBe(other.id);
  });
});
