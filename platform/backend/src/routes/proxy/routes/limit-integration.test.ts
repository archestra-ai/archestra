import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type OpenAI from "openai";
import { vi } from "vitest";
import config from "@/config";
import db, { __setTestDb, getDb, schema } from "@/database";
import {
  EnvironmentDefaultUserLimitModel,
  EnvironmentModel,
  ModelModel,
} from "@/models";
import AgentModel from "@/models/agent";
import AgentTeamModel from "@/models/agent-team";
import TeamModel from "@/models/team";

/**
 * Integration tests for end-to-end LLM proxy limit enforcement.
 *
 * Verifies that real LimitModel limits are checked and enforced during LLM
 * proxy requests — NO mocking of LimitValidationService or the database.
 * Only the upstream LLM client is mocked via createHarness.
 */

import { createFastifyInstance } from "@/fastify-instance";
import LimitModel from "@/models/limit";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { drainBackgroundWork } from "@/utils/background-work";
import { openaiAdapterFactory } from "../adapters/openai";
import openAiProxyRoutes from "./openai";

const DEFAULT_USAGE = { inputTokens: 100, outputTokens: 20 };

function createFastifyApp() {
  return createFastifyInstance();
}

function createOpenAiHarness(options: { usage?: typeof DEFAULT_USAGE } = {}) {
  const usage = options.usage ?? DEFAULT_USAGE;

  return {
    client: {
      chat: {
        completions: {
          create: vi.fn(
            async (
              request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
            ) => ({
              id: "chatcmpl-limit-test",
              object: "chat.completion",
              created: 1,
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant" as const,
                    content: "Mocked response",
                    refusal: null,
                  },
                  finish_reason: "stop" as const,
                  logprobs: null,
                },
              ],
              usage: {
                prompt_tokens: usage.inputTokens,
                completion_tokens: usage.outputTokens,
                total_tokens: usage.inputTokens + usage.outputTokens,
              },
            }),
          ),
        },
      },
    },
  };
}

const OPENAI_ENDPOINT = (agentId: string) =>
  `/v1/openai/${agentId}/chat/completions`;

const OPENAI_HEADERS = (
  authToken = "Bearer test-key",
  platformCredential?: string,
) => ({
  Authorization: authToken,
  "Content-Type": "application/json",
  ...(platformCredential
    ? { "x-archestra-virtual-key": platformCredential }
    : {}),
});

const SIMPLE_PAYLOAD = (model = "gpt-4o") => ({
  model,
  messages: [{ role: "user", content: "Hello" }],
});

describe("LLM proxy limit enforcement (integration)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await ModelModel.create({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  async function setupRoute(harnessOptions?: { usage?: typeof DEFAULT_USAGE }) {
    app = createFastifyApp();
    const harness = createOpenAiHarness(harnessOptions);
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => harness.client as never,
    );
    await app.register(openAiProxyRoutes);
    return harness;
  }

  async function withFailedEntityNameLookup<T>(
    fieldName: string,
    column: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const activeDb = getDb();
    const select = activeDb.select.bind(activeDb);
    __setTestDb(
      new Proxy(activeDb, {
        get(target, property) {
          if (property === "select") {
            return (fields?: Record<string, unknown>) => {
              if (fields?.[fieldName] === column) {
                throw new Error("Simulated display-name lookup failure");
              }
              return select(fields as never);
            };
          }
          return Reflect.get(target, property);
        },
      }),
    );
    try {
      return await run();
    } finally {
      __setTestDb(activeDb);
    }
  }

  describe("personal standard key attribution", () => {
    setupTestCacheManager();
    let organizationId: string;
    let agentId: string;
    let owner: { id: string; email: string };
    let other: { id: string; email: string };
    let credential: string;
    let virtualKeyId: string;
    let providerKeyId: string;
    let harness: ReturnType<typeof createOpenAiHarness>;

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
        const model = await ModelModel.findByProviderAndModelId(
          "openai",
          "gpt-4o",
        );
        if (!model) throw new Error("Missing seeded gpt-4o model");
        await ModelModel.update(model.id, {
          customPricePerMillionInput: "2.50",
          customPricePerMillionOutput: "10.00",
        });
        harness = await setupRoute();
      },
    );

    afterEach(() => drainBackgroundWork());

    const call = (headers: Record<string, string> = {}, token = credential) =>
      app.inject({
        method: "POST",
        url: OPENAI_ENDPOINT(agentId),
        remoteAddress: "203.0.113.5",
        headers: { ...OPENAI_HEADERS(`Bearer ${token}`), ...headers },
        payload: SIMPLE_PAYLOAD(),
      });

    const hints = (): Record<string, string>[] => [
      { "x-archestra-user-id": other.id },
      { "x-openwebui-user-email": other.email },
    ];

    for (const source of ["custom", "default"] as const) {
      test(`${source} owner limit cannot be bypassed with identity hints`, async ({
        makeInteraction,
      }) => {
        const providerCall = harness.client.chat.completions.create;
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
        for (const headers of [{}, ...hints()]) {
          const response = await call(headers);
          expect(response.statusCode, response.body).toBe(402);
          expect(response.json().error.usage_limit).toMatchObject({
            entity_type: "user",
            entity_name: owner.email,
            ...(source === "default" ? { source: "default_user" } : {}),
          });
        }
        expect(providerCall).not.toHaveBeenCalled();
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
        expect(providerCall).toHaveBeenCalledTimes(1);
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
      expect(rows).toHaveLength(2);
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
            currentUsageTokensIn: index === 1 ? 0 : 200,
            currentUsageTokensOut: index === 1 ? 0 : 40,
          },
        ]);
      }
      const spend = await LimitModel.getDefaultUserLimitUsageByUser({
        organizationId,
        models: ["gpt-4o"],
        cleanupInterval: "1w",
      });
      expect(spend.get(owner.id)?.cost).toBeCloseTo(0.0009, 8);
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

  test("a scoped cap refuses its model without dispatch and leaves unrelated models usable", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    await ModelModel.create({
      externalId: "openai/gpt-4o-mini",
      provider: "openai",
      modelId: "gpt-4o-mini",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
    });
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      1_000_000,
      1_000_000,
    );
    const harness = await setupRoute();
    const credential = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: user.id,
    });
    const send = (model: string) =>
      app.inject({
        method: "POST",
        url: OPENAI_ENDPOINT(agent.id),
        headers: OPENAI_HEADERS("Bearer test-key", credential),
        payload: SIMPLE_PAYLOAD(model),
      });

    const blocked = await send("gpt-4o");
    expect(blocked.statusCode, blocked.body).toBe(402);
    expect(blocked.json().error.code).toBe("token_cost_limit_exceeded");
    expect(harness.client.chat.completions.create).not.toHaveBeenCalled();

    const allowed = await send("gpt-4o-mini");
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(harness.client.chat.completions.create).toHaveBeenCalledTimes(1);

    await LimitModel.create({
      entityType: "organization",
      entityId: agent.organizationId,
      limitType: "token_cost",
      limitValue: 0,
      model: null,
      lastCleanup: new Date(),
    });
    const aggregateBlocked = await send("gpt-4o-mini");
    expect(aggregateBlocked.statusCode, aggregateBlocked.body).toBe(402);
    expect(aggregateBlocked.json().error.usage_limit.entity_type).toBe(
      "organization",
    );
    expect(harness.client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("budget applicability uses the normalized model rather than its context variant", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 0,
      model: ["claude-sonnet-4-5"],
      lastCleanup: new Date(),
    });
    config.llmProxy.modelPoolsEnabled = true;
    await LimitModel.create({
      entityType: "organization",
      entityId: agent.organizationId,
      limitType: "token_cost",
      limitValue: 0,
      model: null,
      lastCleanup: new Date(),
    });
    const harness = await setupRoute();
    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(
        "Bearer test-key",
        await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: user.id,
        }),
      ),
      payload: SIMPLE_PAYLOAD("claude-sonnet-4-5[1m]"),
    });

    expect(response.statusCode, response.body).toBe(402);
    expect(response.json().error.usage_limit.entity_type).toBe("agent");
    expect(harness.client.chat.completions.create).not.toHaveBeenCalled();
  });

  test("blocks request with 402 when virtual_key limit is exceeded", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "VK Limit Agent",
    });

    // Create a real virtual key with an OpenAI parent key
    const secret = await makeSecret({ secret: { apiKey: "sk-test-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { virtualKey, value: tokenValue } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Test VK for limit",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: chatApiKey.id },
      ],
    });

    // Create virtual_key limit with threshold of 1
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
    });

    // Pre-populate usage to exceed limit
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      virtualKey.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(`Bearer ${tokenValue}`),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      error: {
        code: "token_cost_limit_exceeded",
        usage_limit: {
          entity_type: "virtual_key",
          entity_name: "Test VK for limit",
          limit_type: "token_cost",
          source: "explicit",
        },
      },
    });
    expect(response.json().error.message).toContain(
      'Affected virtual key: "Test VK for limit".',
    );
    expect(response.json().error.message).toContain("Limit: $1.00");

    const withoutName = await withFailedEntityNameLookup(
      "name",
      schema.virtualApiKeysTable.name,
      () =>
        app.inject({
          method: "POST",
          url: OPENAI_ENDPOINT(agent.id),
          headers: OPENAI_HEADERS(`Bearer ${tokenValue}`),
          payload: SIMPLE_PAYLOAD(),
        }),
    );
    expect(withoutName.statusCode).toBe(402);
    expect(withoutName.json().error.usage_limit).toMatchObject({
      entity_type: "virtual_key",
      source: "explicit",
    });
    expect(withoutName.json().error.usage_limit.entity_name).toBeUndefined();
    expect(withoutName.json().error.message).toContain(
      "Affected scope: virtual key.",
    );
  });

  test("blocks request with 402 when user limit is exceeded", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "User Limit Agent",
    });

    await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
    });

    await LimitModel.updateTokenLimitUsage(
      "user",
      user.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: {
        ...OPENAI_HEADERS(
          "Bearer test-key",
          await makePassthroughCredential({
            organizationId: agent.organizationId,
            ownerId: user.id,
          }),
        ),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      error: {
        code: "token_cost_limit_exceeded",
        usage_limit: {
          entity_type: "user",
          limit_type: "token_cost",
        },
      },
    });
  });

  test("blocks request with 402 when default user limit is exceeded", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Default User Limit Agent",
    });

    await EnvironmentDefaultUserLimitModel.create({
      organizationId: org.id,
      environmentId: null,
      limitValue: 1,
      model: ["gpt-4o"],
      cleanupInterval: "1w",
    });
    const interaction = await makeInteraction(agent.id, {
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 100,
    });
    await db
      .update(schema.interactionsTable)
      .set({ userId: user.id, cost: "2" })
      .where(eq(schema.interactionsTable.id, interaction.id));

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: {
        ...OPENAI_HEADERS(
          "Bearer test-key",
          await makePassthroughCredential({
            organizationId: agent.organizationId,
            ownerId: user.id,
          }),
        ),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      error: {
        code: "token_cost_limit_exceeded",
        usage_limit: {
          entity_type: "user",
          entity_name: user.email,
          limit_type: "token_cost",
          source: "default_user",
        },
      },
    });
    expect(response.json().error.message).toContain("default user cost limit");
    expect(response.json().error.message).toContain(
      `Affected user: "${user.email}".`,
    );

    const credential = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: user.id,
    });
    const withoutName = await withFailedEntityNameLookup(
      "email",
      schema.usersTable.email,
      () =>
        app.inject({
          method: "POST",
          url: OPENAI_ENDPOINT(agent.id),
          headers: {
            ...OPENAI_HEADERS("Bearer test-key", credential),
            "X-Archestra-User-Id": user.id,
          },
          payload: SIMPLE_PAYLOAD(),
        }),
    );
    expect(withoutName.statusCode).toBe(402);
    expect(withoutName.json().error.usage_limit).toMatchObject({
      entity_type: "user",
      source: "default_user",
    });
    expect(withoutName.json().error.usage_limit.entity_name).toBeUndefined();
    expect(withoutName.json().error.message).toContain("Affected scope: user.");
  });

  test("uses custom user limit instead of default user limit", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Custom User Limit Override Agent",
    });

    await EnvironmentDefaultUserLimitModel.create({
      organizationId: org.id,
      environmentId: null,
      limitValue: 1,
      model: null,
      cleanupInterval: "1w",
    });
    await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 100,
      model: null,
      cleanupInterval: "1w",
    });
    const interaction = await makeInteraction(agent.id, {
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 100,
    });
    await db
      .update(schema.interactionsTable)
      .set({ userId: user.id, cost: "2" })
      .where(eq(schema.interactionsTable.id, interaction.id));
    await ModelModel.ensureModelExists("gpt-4o", "openai");

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: {
        ...OPENAI_HEADERS(
          "Bearer test-key",
          await makePassthroughCredential({
            organizationId: agent.organizationId,
            ownerId: user.id,
          }),
        ),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);
  });

  test("allows request when limits are not exceeded", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({ name: "Under Limit Agent" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);

    // Create agent limit with a very high threshold (1B tokens)
    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: ["gpt-4o"],
    });

    // Ensure model exists for cost tracking
    await ModelModel.ensureModelExists("gpt-4o", "openai");

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(
        "Bearer test-key",
        await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: owner.id,
        }),
      ),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);
  });

  test("blocks org-scoped agent with 402 when organization limit is exceeded", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Org Limit Agent",
    });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);

    await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 1,
      model: null,
      lastCleanup: new Date(),
    });

    await LimitModel.updateTokenLimitUsage(
      "organization",
      org.id,
      "gpt-4o",
      1_000_000,
      1_000_000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(
        "Bearer test-key",
        await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: owner.id,
        }),
      ),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      error: {
        code: "token_cost_limit_exceeded",
        usage_limit: {
          entity_type: "organization",
          limit_type: "token_cost",
        },
      },
    });
    expect(response.json().error.message).toContain("organization-level");
  });

  test("records usage in limit after successful request", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({ name: "Usage Record Agent" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);

    // Create agent limit with high threshold
    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: ["gpt-4o"],
    });

    // Ensure model exists for cost tracking
    await ModelModel.ensureModelExists("gpt-4o", "openai");

    await setupRoute({
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(
        "Bearer test-key",
        await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: owner.id,
        }),
      ),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);

    // Verify usage was recorded in the limit
    const breakdown =
      (await LimitModel.getModelUsageBreakdowns([limit.id])).get(limit.id) ??
      [];
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].model).toBe("gpt-4o");
    // Usage should be > 0 (exact amount depends on cost calculation,
    // but tokens should match what the mock returned)
    expect(breakdown[0].tokensIn).toBeGreaterThan(0);
    expect(breakdown[0].tokensOut).toBeGreaterThan(0);
  });

  test("blocks with most specific limit when multiple exist", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Multi-Limit Agent",
    });

    // Create a real virtual key
    const secret = await makeSecret({ secret: { apiKey: "sk-test-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { virtualKey, value: tokenValue } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Multi-Limit VK",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: chatApiKey.id },
      ],
    });

    // Create limits at all three levels — all exceeded
    // Virtual key limit (most specific)
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
    });
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      virtualKey.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    // User limit
    await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
    });
    await LimitModel.updateTokenLimitUsage(
      "user",
      user.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    // Agent limit
    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
    });
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: {
        ...OPENAI_HEADERS(`Bearer ${tokenValue}`),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    const body = response.json();
    expect(body.error.code).toBe("token_cost_limit_exceeded");
    // virtual_key is checked first (most specific), so error should mention it
    expect(body.error.message).toContain("virtual key-level");
  });

  test("records usage in team all-models limit after successful request", async ({
    makeAgent,
    makeOrganization,
    makeAdmin,
    makeTeam,
    makeMember,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, admin.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Team All-Models Agent",
      access: { teams: [team.id] },
    });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    // Team limits follow the agent's team assignment, not its grants.
    await TeamModel.addMember(team.id, owner.id);
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    // Create team-level all-models limit (model: null)
    const teamLimit = await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: null,
    });

    await ModelModel.ensureModelExists("gpt-4o", "openai");

    await setupRoute({
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(
        "Bearer test-key",
        await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: owner.id,
        }),
      ),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);

    // Tick to let background update run
    // TODO: if calls to InteractionModel.updateUsageAfterInteraction change might want to change the test as well
    await new Promise((resolve) => setTimeout(resolve, 200));

    // BUG REPRODUCTION: team all-models limit usage should be updated
    const teamUsage =
      (await LimitModel.getModelUsageBreakdowns([teamLimit.id])).get(
        teamLimit.id,
      ) ?? [];
    expect(teamUsage).toHaveLength(1);
    expect(teamUsage[0].model).toBe("gpt-4o");
    expect(teamUsage[0].tokensIn).toBe(500);
    expect(teamUsage[0].tokensOut).toBe(100);
  });

  test("records usage in team all-models limit when agent has multiple teams", async ({
    makeAgent,
    makeOrganization,
    makeAdmin,
    makeTeam,
    makeMember,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team1 = await makeTeam(org.id, admin.id, { name: "Team 1" });
    const team2 = await makeTeam(org.id, admin.id, { name: "Team 2" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Multi-Team All-Models Agent",
      access: { teams: [team1.id, team2.id] },
    });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    // Team limits follow the agent's team assignment, not its grants.
    await TeamModel.addMember(team1.id, owner.id);
    await TeamModel.addMember(team2.id, owner.id);
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team1.id, team2.id]);

    // Create all-models limit on team1 ONLY
    const team1Limit = await LimitModel.create({
      entityType: "team",
      entityId: team1.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: null,
    });

    // Create specific-model limit on team2
    const team2Limit = await LimitModel.create({
      entityType: "team",
      entityId: team2.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: ["gpt-4o"],
    });

    // Also create org and user limits to verify they update (control group)
    const orgLimit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: null,
    });

    await ModelModel.ensureModelExists("gpt-4o", "openai");

    await setupRoute({
      usage: { inputTokens: 300, outputTokens: 60 },
    });

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(
        "Bearer test-key",
        await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: owner.id,
        }),
      ),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);

    // Tick to let background update run
    // TODO: if calls to InteractionModel.updateUsageAfterInteraction change might want to change the test as well
    await new Promise((resolve) => setTimeout(resolve, 200));

    // BUG REPRODUCTION: team1 all-models limit usage must be updated
    const team1Usage =
      (await LimitModel.getModelUsageBreakdowns([team1Limit.id])).get(
        team1Limit.id,
      ) ?? [];
    expect(team1Usage).toHaveLength(1);
    expect(team1Usage[0].model).toBe("gpt-4o");
    expect(team1Usage[0].tokensIn).toBe(300);
    expect(team1Usage[0].tokensOut).toBe(60);

    // team2 specific-model limit should also be updated
    const team2Usage =
      (await LimitModel.getModelUsageBreakdowns([team2Limit.id])).get(
        team2Limit.id,
      ) ?? [];
    expect(team2Usage).toHaveLength(1);
    expect(team2Usage[0].tokensIn).toBe(300);
    expect(team2Usage[0].tokensOut).toBe(60);

    // org all-models limit should be updated (control — user confirmed this works)
    const orgUsage =
      (await LimitModel.getModelUsageBreakdowns([orgLimit.id])).get(
        orgLimit.id,
      ) ?? [];
    expect(orgUsage).toHaveLength(1);
    expect(orgUsage[0].model).toBe("gpt-4o");
    expect(orgUsage[0].tokensIn).toBe(300);
    expect(orgUsage[0].tokensOut).toBe(60);
  });

  test("blocks request with 402 when team all-models limit is exceeded", async ({
    makeAgent,
    makeOrganization,
    makeAdmin,
    makeTeam,
    makeMember,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, admin.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Team All-Models Blocked Agent",
      access: { teams: [team.id] },
    });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    // Team limits follow the agent's team assignment, not its grants.
    await TeamModel.addMember(team.id, owner.id);
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    // Create team all-models limit with threshold of 1
    await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1,
      model: null,
      lastCleanup: new Date(),
    });

    // Pre-populate usage to exceed limit
    await LimitModel.updateTokenLimitUsage(
      "team",
      team.id,
      "gpt-4o",
      1_000_000,
      1_000_000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(
        "Bearer test-key",
        await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: owner.id,
        }),
      ),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    const body = response.json();
    expect(body.error.code).toBe("token_cost_limit_exceeded");
    expect(body.error.message).toContain("team-level");
    expect(body.error.message).toContain(`Affected team: "${team.name}".`);
    expect(body.error.usage_limit).toEqual({
      entity_type: "team",
      entity_name: team.name,
      limit_type: "token_cost",
      source: "explicit",
    });
  });

  test("blocks request with 402 when user all-models limit is exceeded", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "User All-Models Limit Agent",
    });

    // Create user all-models limit (model: null) with threshold of 1
    await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1,
      model: null,
      lastCleanup: new Date(),
    });

    // Pre-populate usage to exceed limit
    await LimitModel.updateTokenLimitUsage(
      "user",
      user.id,
      "gpt-4o",
      1_000_000,
      1_000_000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: {
        ...OPENAI_HEADERS(
          "Bearer test-key",
          await makePassthroughCredential({
            organizationId: agent.organizationId,
            ownerId: user.id,
          }),
        ),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    const body = response.json();
    expect(body.error.code).toBe("token_cost_limit_exceeded");
    expect(body.error.message).toContain("user-level");
  });

  test("blocks request with 402 when virtual_key all-models limit is exceeded", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "VK All-Models Limit Agent",
    });

    // Create a real virtual key with an OpenAI parent key
    const secret = await makeSecret({ secret: { apiKey: "sk-test-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { virtualKey, value: tokenValue } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Test VK for all-models limit",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: chatApiKey.id },
      ],
    });

    // Create virtual_key all-models limit (model: null) with threshold of 1
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: 1,
      model: null,
      lastCleanup: new Date(),
    });

    // Pre-populate usage to exceed limit
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      virtualKey.id,
      "gpt-4o",
      1_000_000,
      1_000_000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(`Bearer ${tokenValue}`),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    const body = response.json();
    expect(body.error.code).toBe("token_cost_limit_exceeded");
    expect(body.error.message).toContain("virtual key-level");
  });

  test("blocks request with 402 when environment limit is exceeded", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const environment = await EnvironmentModel.create({
      organizationId: org.id,
      name: "production",
    });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Env Limit Agent",
      environmentId: environment.id,
    });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);

    await LimitModel.create({
      entityType: "environment",
      entityId: environment.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
    });
    await LimitModel.updateTokenLimitUsage(
      "environment",
      environment.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(
        "Bearer test-key",
        await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: owner.id,
        }),
      ),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      error: {
        code: "token_cost_limit_exceeded",
        usage_limit: {
          entity_type: "environment",
          limit_type: "token_cost",
        },
      },
    });
  });

  test("does not apply an environment limit to an agent in a different environment", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const limitedEnv = await EnvironmentModel.create({
      organizationId: org.id,
      name: "production",
    });
    // Agent has no environment, so the production env limit must not apply.
    const agent = await makeAgent({
      organizationId: org.id,
      name: "No-Env Agent",
    });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);

    await LimitModel.create({
      entityType: "environment",
      entityId: limitedEnv.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
    });
    await LimitModel.updateTokenLimitUsage(
      "environment",
      limitedEnv.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(
        "Bearer test-key",
        await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: owner.id,
        }),
      ),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);
  });

  test("blocks request with 402 when per-environment default user limit is exceeded", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const environment = await EnvironmentModel.create({
      organizationId: org.id,
      name: "production",
    });
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Env Default Agent",
      environmentId: environment.id,
    });

    await EnvironmentDefaultUserLimitModel.create({
      organizationId: org.id,
      environmentId: environment.id,
      limitValue: 1,
      cleanupInterval: "1w",
    });

    const interaction = await makeInteraction(agent.id, {
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 100,
    });
    await db
      .update(schema.interactionsTable)
      .set({ userId: user.id, environmentId: environment.id, cost: "2" })
      .where(eq(schema.interactionsTable.id, interaction.id));

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: {
        ...OPENAI_HEADERS(
          "Bearer test-key",
          await makePassthroughCredential({
            organizationId: agent.organizationId,
            ownerId: user.id,
          }),
        ),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      error: {
        code: "token_cost_limit_exceeded",
        usage_limit: {
          entity_type: "environment",
          limit_type: "token_cost",
        },
      },
    });
  });

  test("per-environment default user limit overrides the org-wide default", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const environment = await EnvironmentModel.create({
      organizationId: org.id,
      name: "production",
    });
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Override Agent",
      environmentId: environment.id,
    });

    // Org-wide default (NULL environment) would block (limit of 1, usage of 2)...
    await EnvironmentDefaultUserLimitModel.create({
      organizationId: org.id,
      environmentId: null,
      limitValue: 1,
      model: ["gpt-4o"],
      cleanupInterval: "1w",
    });
    // ...but a generous per-environment default overrides it for this env.
    await EnvironmentDefaultUserLimitModel.create({
      organizationId: org.id,
      environmentId: environment.id,
      limitValue: 1000000,
      cleanupInterval: "1w",
    });

    const interaction = await makeInteraction(agent.id, {
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 100,
    });
    await db
      .update(schema.interactionsTable)
      .set({ userId: user.id, environmentId: environment.id, cost: "2" })
      .where(eq(schema.interactionsTable.id, interaction.id));

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: {
        ...OPENAI_HEADERS(
          "Bearer test-key",
          await makePassthroughCredential({
            organizationId: agent.organizationId,
            ownerId: user.id,
          }),
        ),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);
  });

  test("per-environment default user usage still counts interactions from a deleted agent", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const environment = await EnvironmentModel.create({
      organizationId: org.id,
      name: "production",
    });
    const user = await makeUser();
    await makeMember(user.id, org.id);

    // The agent that produced past usage is later deleted; a sibling agent in
    // the same environment serves the new request.
    const deletedAgent = await makeAgent({
      organizationId: org.id,
      name: "Deleted Env Agent",
      environmentId: environment.id,
    });
    const activeAgent = await makeAgent({
      organizationId: org.id,
      name: "Active Env Agent",
      environmentId: environment.id,
    });

    await EnvironmentDefaultUserLimitModel.create({
      organizationId: org.id,
      environmentId: environment.id,
      limitValue: 1,
      cleanupInterval: "1w",
    });

    const interaction = await makeInteraction(deletedAgent.id, {
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 100,
    });
    await db
      .update(schema.interactionsTable)
      .set({ userId: user.id, environmentId: environment.id, cost: "2" })
      .where(eq(schema.interactionsTable.id, interaction.id));

    await AgentModel.delete(deletedAgent.id);

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(activeAgent.id),
      headers: {
        ...OPENAI_HEADERS(
          "Bearer test-key",
          await makePassthroughCredential({
            organizationId: deletedAgent.organizationId,
            ownerId: user.id,
          }),
        ),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      error: {
        usage_limit: {
          entity_type: "environment",
          limit_type: "token_cost",
        },
      },
    });
  });
});
