import { HttpResponse, http } from "msw";
import { buildProxyBaseUrl } from "@/clients/llm-client";
import config from "@/config";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import ConversationModel from "@/models/conversation";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import ModelPoolModel from "@/models/model-pool";
import openAiProxyRoutes from "@/routes/proxy/routes/openai";
import { applyAgentModelPool } from "@/services/chat-model-pools";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import type { Agent, User } from "@/types";
import chatRoutes from "./routes";

/**
 * A conversation may run through its agent's configured key without a grant
 * on that key: permission flows through the agent. When one PATCH switches the
 * agent and sends a key, that exemption belongs to the agent the conversation
 * is switching TO, not the one it is leaving.
 */
describe("PATCH /api/chat/conversations/:id API key when switching agent", () => {
  let app: FastifyInstanceWithZod;
  let member: User;
  let organizationId: string;
  let modelId: string;
  let leavingAgentId: string;
  let leavingAgentKeyId: string;
  let nextAgentId: string;
  let nextAgentKeyId: string;
  let conversationId: string;

  beforeEach(
    async ({
      makeAgent,
      makeConversation,
      makeLlmProviderApiKey,
      makeMember,
      makeOrganization,
      makeSecret,
      makeUser,
    }) => {
      organizationId = (await makeOrganization()).id;
      member = await makeUser();
      await makeMember(member.id, organizationId, { role: "member" });

      const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
      // Neither key is shared with the member: each is reachable only through
      // the agent that pins it.
      const [leavingKey, nextKey] = await Promise.all(
        ["leaving", "next"].map((name) =>
          makeLlmProviderApiKey(organizationId, secret.id, {
            name: `${name} agent key`,
            provider: "openai",
            access: { users: [] },
          }),
        ),
      );
      leavingAgentKeyId = leavingKey.id;
      nextAgentKeyId = nextKey.id;
      const model = await ModelModel.create({
        externalId: "openai/agent-switch-model",
        provider: "openai",
        modelId: "agent-switch-model",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });
      modelId = model.id;
      await Promise.all(
        [leavingKey, nextKey].map((key) =>
          LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
            model.id,
          ]),
        ),
      );

      const [leavingAgent, nextAgent] = await Promise.all(
        [leavingKey, nextKey].map((key) =>
          makeAgent({
            organizationId,
            agentType: "agent",
            modelId: model.id,
            llmApiKeyId: key.id,
          }),
        ),
      );
      leavingAgentId = leavingAgent.id;
      nextAgentId = nextAgent.id;
      conversationId = (
        await makeConversation(leavingAgentId, {
          userId: member.id,
          organizationId,
        })
      ).id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = member;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  const switchAgent = (agentId: string, chatApiKeyId: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversationId}`,
      payload: { agentId, modelId, chatApiKeyId },
    });

  test("accepts the new agent's own key sent together with the switch", async () => {
    const response = await switchAgent(nextAgentId, nextAgentKeyId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: nextAgentId,
      modelId,
      chatApiKeyId: nextAgentKeyId,
    });
  });

  test("refuses the agent being left's key on the new agent", async () => {
    const response = await switchAgent(nextAgentId, leavingAgentKeyId);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(
      "You do not have access to this API key",
    );
  });

  test("still exempts the current agent's key when the agent is unchanged", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversationId}`,
      payload: { modelId, chatApiKeyId: leavingAgentKeyId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: leavingAgentId,
      chatApiKeyId: leavingAgentKeyId,
    });
  });
});

beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});
setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
const sharedOrigin = "https://chat-pool-shared.example.test/v1";

const poolTest = test.extend<{
  pooled: {
    app: FastifyInstanceWithZod;
    caller: User;
    organizationId: string;
    agent: Agent;
    directAgent: Agent;
    poolId: string;
    copilotKeyId: string;
    copilotModelId: string;
    sharedKeyId: string;
    sharedModelId: string;
  };
}>({
  pooled: async (
    {
      makeOrganization,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    },
    use,
  ) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const caller = await makeUser();
    await makeMember(owner.id, org.id);
    await makeMember(caller.id, org.id);
    const copilot = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "gho_chat_pool_owner" } })).id,
      { provider: "github-copilot", userId: owner.id },
    );
    const shared = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "shared-chat-pool-key" } })).id,
      {
        provider: "openai",
        baseUrl: sharedOrigin,
        access: { users: [owner.id], preset: "use" },
      },
    );
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "shared-chat-pool",
        members: [copilot, shared].map((key, i) => ({
          providerApiKeyId: key.id,
          modelId: "gpt-4.1",
          priority: i + 1,
          weight: 1,
          enabled: true,
        })),
      },
    });
    const configured: Parameters<typeof applyAgentModelPool>[0] = {
      modelPoolId: pool.id,
    };
    await applyAgentModelPool(configured, {
      organizationId: org.id,
      userId: owner.id,
    });
    await ModelModel.ensureModelExists("gpt-4.1", "openai");
    const sharedModel = await ModelModel.findByProviderAndModelId(
      "openai",
      "gpt-4.1",
    );
    if (!configured.modelId || !sharedModel)
      throw new Error("Missing fixture model");
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(copilot.id, [
      configured.modelId,
    ]);
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(shared.id, [
      sharedModel.id,
    ]);
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "agent",
      modelPoolId: pool.id,
      llmApiKeyId: copilot.id,
      modelId: configured.modelId,
      systemPrompt: "Answer briefly.",
    });
    const directAgent = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "agent",
      llmApiKeyId: shared.id,
      modelId: sharedModel.id,
    });
    const app = createFastifyInstance();
    // Authentication is the process boundary. All route permissions, model
    // selection, credential resolution and provider dispatch remain real.
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: caller, organizationId: org.id });
    });
    await app.register(chatRoutes);
    await app.register(openAiProxyRoutes);
    try {
      await use({
        app,
        caller,
        organizationId: org.id,
        agent,
        directAgent,
        poolId: pool.id,
        copilotKeyId: copilot.id,
        copilotModelId: configured.modelId,
        sharedKeyId: shared.id,
        sharedModelId: sharedModel.id,
      });
    } finally {
      await app.close();
    }
  },
});

poolTest(
  "fresh chats inherit the caller-usable agent pool, including the frontend's explicit pool payload",
  async ({ pooled }) => {
    expect(
      await LlmProviderApiKeyModel.getAvailableKeysForUser(
        pooled.organizationId,
        pooled.caller.id,
        [],
      ),
    ).toEqual([]);
    for (const payload of [
      { agentId: pooled.agent.id },
      {
        agentId: pooled.agent.id,
        modelPoolId: pooled.poolId,
        modelId: pooled.copilotModelId,
        chatApiKeyId: pooled.copilotKeyId,
      },
    ]) {
      const response = await pooled.app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        agentId: pooled.agent.id,
        modelPoolId: pooled.poolId,
        modelId: pooled.sharedModelId,
        chatApiKeyId: pooled.sharedKeyId,
      });
    }
  },
);

poolTest(
  "switching with only agentId stores a complete shared fallback pair",
  async ({ pooled, makeConversation }) => {
    const conversation = await makeConversation(pooled.directAgent.id, {
      userId: pooled.caller.id,
      organizationId: pooled.organizationId,
      modelId: pooled.sharedModelId,
      chatApiKeyId: pooled.sharedKeyId,
    });
    const response = await pooled.app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversation.id}`,
      payload: { agentId: pooled.agent.id },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: pooled.agent.id,
      modelPoolId: pooled.poolId,
      modelId: pooled.sharedModelId,
      chatApiKeyId: pooled.sharedKeyId,
    });
    const reselected = await pooled.app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversation.id}`,
      payload: { modelPoolId: pooled.poolId },
    });
    expect(reselected.statusCode, reselected.body).toBe(200);
    expect(reselected.json()).toMatchObject({
      modelPoolId: pooled.poolId,
      chatApiKeyId: pooled.sharedKeyId,
    });
  },
);

poolTest(
  "a pooled chat turn refreshes a stale personal anchor and streams through the inherited shared key",
  async ({ pooled, makeConversation }) => {
    const conversation = await makeConversation(pooled.agent.id, {
      userId: pooled.caller.id,
      organizationId: pooled.organizationId,
      title: "Pool regression",
      modelId: pooled.copilotModelId,
      chatApiKeyId: pooled.copilotKeyId,
    });
    await ConversationModel.update(
      conversation.id,
      pooled.caller.id,
      pooled.organizationId,
      { modelPoolId: pooled.poolId },
    );
    let sharedCalls = 0;
    let ownerExchanges = 0;
    const mcpUrl = `${new URL(buildProxyBaseUrl("openai", pooled.agent.id)).origin}/v1/mcp/${pooled.agent.id}`;
    server.use(
      // The MCP gateway is a separate HTTP process boundary. This agent has
      // no tools; leave the real chat MCP client and context builder intact.
      http.post(mcpUrl, async ({ request }) => {
        const body = (await request.json()) as { method: string; id?: number };
        if (body.id === undefined)
          return new HttpResponse(null, { status: 202 });
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture-gateway", version: "1" },
                }
              : { tools: [] },
        });
      }),
      http.get(mcpUrl, () => new HttpResponse(null, { status: 405 })),
      http.get(config.llm["github-copilot"].tokenExchangeUrl, () => {
        ownerExchanges++;
        return HttpResponse.json({}, { status: 401 });
      }),
      http.post(`${sharedOrigin}/chat/completions`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer shared-chat-pool-key",
        );
        expect(await request.json()).toMatchObject({
          model: "gpt-4.1",
          stream: true,
        });
        sharedCalls++;
        return new HttpResponse(openAiTextStream("Shared pool answer"), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
      http.post(
        `${buildProxyBaseUrl("openai", pooled.agent.id)}/chat/completions`,
        async ({ request }) => {
          const response = await pooled.app.inject({
            method: "POST",
            url: new URL(request.url).pathname,
            headers: Object.fromEntries(request.headers.entries()),
            payload: await request.text(),
          });
          expect(response.statusCode, response.body).toBe(200);
          return new HttpResponse(response.body, {
            status: response.statusCode,
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );
    const response = await pooled.app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversation.id,
        messages: [
          {
            id: "pool-user-message",
            role: "user",
            parts: [{ type: "text", text: "Hello" }],
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("Shared pool answer");
    expect(sharedCalls).toBe(1);
    expect(ownerExchanges).toBe(0);
    expect(await db.select().from(schema.interactionsTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: pooled.caller.id,
          providerApiKeyId: pooled.sharedKeyId,
          modelPoolId: pooled.poolId,
          attemptOutcome: "answered",
        }),
      ]),
    );
  },
);

poolTest(
  "explicit pool selection on an unrelated agent still requires direct key access",
  async ({ pooled, makeConversation }) => {
    const response = await pooled.app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: { agentId: pooled.directAgent.id, modelPoolId: pooled.poolId },
    });
    expect(response.statusCode, response.body).toBe(404);
    const conversation = await makeConversation(pooled.directAgent.id, {
      userId: pooled.caller.id,
      organizationId: pooled.organizationId,
    });
    const updated = await pooled.app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversation.id}`,
      payload: { modelPoolId: pooled.poolId },
    });
    expect(updated.statusCode, updated.body).toBe(404);
  },
);

poolTest(
  "an explicit direct selection still requires direct key access",
  async ({ pooled }) => {
    const direct = await pooled.app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: {
        agentId: pooled.agent.id,
        modelId: pooled.sharedModelId,
        chatApiKeyId: pooled.sharedKeyId,
      },
    });
    expect(direct.statusCode, direct.body).toBe(403);
  },
);

poolTest(
  "disabled pools leave implicit Chat creation on the prior direct-provider path",
  async ({ pooled }) => {
    config.llmProxy.modelPoolsEnabled = false;
    const response = await pooled.app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: { agentId: pooled.agent.id },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      modelPoolId: null,
      modelId: pooled.copilotModelId,
      chatApiKeyId: null,
    });
  },
);

function openAiTextStream(text: string) {
  const base = {
    id: "pool-completion",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4.1",
  };
  return `${[
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}
