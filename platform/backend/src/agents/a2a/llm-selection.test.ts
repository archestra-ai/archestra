import { generateText } from "ai";
import { HttpResponse, http } from "msw";
import {
  buildProxyBaseUrl,
  createLLMModelForAgent,
} from "@/clients/llm-client";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import ModelPoolModel from "@/models/model-pool";
import githubCopilotRoutes from "@/routes/proxy/routes/github-copilot";
import openAiProxyRoutes from "@/routes/proxy/routes/openai";
import {
  applyAgentModelPool,
  resolveChatModelPool,
} from "@/services/chat-model-pools";
import { beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { LlmProviderAuthRequiredError } from "@/utils/llm-provider-auth-error";
import { resolveRunLlmSelection } from "./llm-selection";

beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});
setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
const sharedOrigin = "https://agent-pool-shared.example.test/v1";
const copilotOrigin = "https://agent-pool-copilot.example.test";

const poolTest = test.extend<{
  pooledAgent: {
    agentId: string;
    organizationId: string;
    ownerId: string;
    callerId: string;
    agent: {
      llmApiKeyId: string;
      modelId: string;
      modelPoolId: string;
      autoRouterId: null;
      runtime: null;
    };
    sharedKeyId: string;
    sharedModelId: string;
  };
}>({
  pooledAgent: async (
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
      (await makeSecret({ secret: { apiKey: "gho_agent_pool_owner" } })).id,
      { provider: "github-copilot", userId: owner.id },
    );
    const shared = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "shared-agent-pool-key" } })).id,
      {
        provider: "openai",
        baseUrl: sharedOrigin,
        // Agent access, not a direct grant, lets the other caller use this key.
        access: { users: [owner.id], preset: "use" },
      },
    );
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "agent-pool",
        members: [member(copilot.id, 1), member(shared.id, 2)],
      },
    });
    const configured: Parameters<typeof applyAgentModelPool>[0] = {
      modelPoolId: pool.id,
    };
    await applyAgentModelPool(configured, {
      organizationId: org.id,
      userId: owner.id,
    });
    expect(configured.llmApiKeyId).toBe(copilot.id);
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
    });
    await use({
      agentId: agent.id,
      organizationId: org.id,
      ownerId: owner.id,
      callerId: caller.id,
      agent: {
        llmApiKeyId: copilot.id,
        modelId: configured.modelId,
        modelPoolId: pool.id,
        autoRouterId: null,
        runtime: null,
      },
      sharedKeyId: shared.id,
      sharedModelId: sharedModel.id,
    });
  },
});

poolTest(
  "the A2A selector and real LLM client reach a shared fallback without the owner's Copilot",
  async ({ pooledAgent }) => {
    const { agent, organizationId, callerId, ownerId, sharedKeyId } =
      pooledAgent;
    const available = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      organizationId,
      callerId,
      [],
    );
    expect(available).toEqual([]);
    await expect(
      resolveChatModelPool({
        organizationId,
        userId: callerId,
        modelPoolId: agent.modelPoolId,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    let copilotCalls = 0;
    let exchanges = 0;
    let sharedCalls = 0;
    server.use(
      http.get(config.llm["github-copilot"].tokenExchangeUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "token gho_agent_pool_owner",
        );
        exchanges++;
        return HttpResponse.json({
          token: "agent-pool-copilot-session",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: copilotOrigin },
        });
      }),
      http.post(`${copilotOrigin}/chat/completions`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer agent-pool-copilot-session",
        );
        copilotCalls++;
        return HttpResponse.json(completion("personal answer"));
      }),
      http.post(`${sharedOrigin}/chat/completions`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer shared-agent-pool-key",
        );
        sharedCalls++;
        return HttpResponse.json(completion("shared answer"));
      }),
    );
    const app = createFastifyInstance();
    await app.register(githubCopilotRoutes);
    await app.register(openAiProxyRoutes);
    try {
      for (const userId of [callerId, ownerId]) {
        // Exercise the same production selector used by executeA2AMessage.
        // Keep the client credential precheck and the proxy fully real as well.
        const selection = await resolveRunLlmSelection({
          agent,
          organizationId,
          userId,
        });
        const client = await createLLMModelForAgent({
          organizationId,
          userId,
          agentId: pooledAgent.agentId,
          model: selection.selectedModel,
          provider: selection.selectedProvider,
          agentLlmApiKeyId: selection.chatApiKeyId ?? agent.llmApiKeyId,
          modelPoolId: agent.modelPoolId,
          source: "api",
        });
        const path = `${buildProxyBaseUrl(selection.selectedProvider, pooledAgent.agentId)}/chat/completions`;
        // Replace only the loopback HTTP transport, not the handler or auth.
        server.use(
          http.post(path, async ({ request }) => {
            const response = await app.inject({
              method: "POST",
              url: new URL(request.url).pathname,
              headers: Object.fromEntries(request.headers.entries()),
              payload: await request.text(),
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.headers["x-archestra-provider-key"]).toBe(
              userId === ownerId ? agent.llmApiKeyId : sharedKeyId,
            );
            return new HttpResponse(response.body, {
              status: response.statusCode,
              headers: { "content-type": "application/json" },
            });
          }),
        );
        const answer = await generateText({
          model: client.model,
          prompt: "Hello",
          maxRetries: 0,
        });
        expect(answer.text).toBe(
          userId === ownerId ? "personal answer" : "shared answer",
        );
        if (userId === callerId) {
          expect(exchanges).toBe(0);
          expect(copilotCalls).toBe(0);
          expect(client.chatApiKeyId).toBe(sharedKeyId);
        }
      }
      expect(exchanges).toBe(1);
      expect(copilotCalls).toBe(1);
      expect(sharedCalls).toBe(1);
      const interactions = await db.select().from(schema.interactionsTable);
      expect(interactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: callerId,
            providerApiKeyId: sharedKeyId,
            modelPoolId: agent.modelPoolId,
            attemptOutcome: "answered",
          }),
          expect.objectContaining({
            userId: ownerId,
            providerApiKeyId: agent.llmApiKeyId,
            modelPoolId: agent.modelPoolId,
            attemptOutcome: "answered",
          }),
        ]),
      );
    } finally {
      await app.close();
    }
  },
);

poolTest(
  "direct Copilot still requires the caller's account and a self-fork keeps its parent model",
  async ({ pooledAgent }) => {
    const {
      agent,
      organizationId,
      callerId,
      ownerId,
      sharedKeyId,
      sharedModelId,
    } = pooledAgent;
    // A direct selection and a self-fork without a parent both keep the
    // existing per-user provider check, rather than inheriting the pool.
    for (const selfFork of [false, true]) {
      const direct = await resolveRunLlmSelection({
        agent: selfFork ? agent : { ...agent, modelPoolId: null },
        selfFork,
        organizationId,
        userId: callerId,
      });
      await expect(
        createLLMModelForAgent({
          organizationId,
          userId: callerId,
          agentId: pooledAgent.agentId,
          model: direct.selectedModel,
          provider: direct.selectedProvider,
          agentLlmApiKeyId: agent.llmApiKeyId,
        }),
      ).rejects.toBeInstanceOf(LlmProviderAuthRequiredError);
    }
    const fork = await resolveRunLlmSelection({
      agent,
      organizationId,
      userId: ownerId,
      selfFork: true,
      parentLlm: { modelId: sharedModelId, apiKeyId: sharedKeyId },
    });
    expect(fork).toMatchObject({
      modelId: sharedModelId,
      chatApiKeyId: sharedKeyId,
      selectedProvider: "openai",
    });
  },
);

poolTest(
  "agent anchors exclude disabled, foreign-organization, and other users' personal members",
  async ({
    pooledAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const { agent, organizationId, callerId } = pooledAgent;
    const foreignOrg = await makeOrganization();
    const foreignKey = await makeLlmProviderApiKey(
      foreignOrg.id,
      (await makeSecret({ secret: { apiKey: "foreign-key" } })).id,
      { provider: "openai" },
    );
    await ModelPoolModel.update({
      organizationId,
      id: agent.modelPoolId,
      input: {
        name: "agent-pool",
        members: [
          member(agent.llmApiKeyId, 1),
          member(foreignKey.id, 2),
          { ...member(pooledAgent.sharedKeyId, 3), enabled: false },
        ],
      },
    });
    for (const userId of [callerId, "system"]) {
      await expect(
        resolveRunLlmSelection({ agent, organizationId, userId }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    await expect(
      resolveRunLlmSelection({
        agent,
        organizationId: foreignOrg.id,
        userId: pooledAgent.ownerId,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  },
);

poolTest(
  "a disconnected personal anchor no longer blocks the owner's shared fallback",
  async ({ pooledAgent }) => {
    const { agent, organizationId, ownerId, sharedKeyId } = pooledAgent;
    await LlmProviderApiKeyModel.setRequiresReauthentication({
      id: agent.llmApiKeyId,
      requiresReauthentication: true,
    });
    const resolve = () =>
      resolveRunLlmSelection({ agent, organizationId, userId: ownerId });
    expect(await resolve()).toMatchObject({
      chatApiKeyId: sharedKeyId,
      selectedProvider: "openai",
    });
    await LlmProviderApiKeyModel.setRequiresReauthentication({
      id: agent.llmApiKeyId,
      requiresReauthentication: false,
    });
    await LlmProviderApiKeyModel.update(agent.llmApiKeyId, { secretId: null });
    expect(await resolve()).toMatchObject({
      chatApiKeyId: sharedKeyId,
      selectedProvider: "openai",
    });
  },
);

poolTest(
  "a keyless shared fallback remains a usable agent anchor",
  async ({ pooledAgent, makeLlmProviderApiKey }) => {
    const { agent, organizationId, callerId } = pooledAgent;
    const keyless = await makeLlmProviderApiKey(organizationId, null, {
      provider: "vllm",
      baseUrl: "https://keyless-agent-pool.example.test/v1",
      access: { users: [pooledAgent.ownerId], preset: "use" },
    });
    await ModelPoolModel.update({
      organizationId,
      id: agent.modelPoolId,
      input: {
        name: "agent-pool",
        members: [member(agent.llmApiKeyId, 1), member(keyless.id, 2)],
      },
    });
    const selection = await resolveRunLlmSelection({
      agent,
      organizationId,
      userId: callerId,
    });
    const client = await createLLMModelForAgent({
      organizationId,
      userId: callerId,
      agentId: pooledAgent.agentId,
      model: selection.selectedModel,
      provider: selection.selectedProvider,
      agentLlmApiKeyId: selection.chatApiKeyId,
      modelPoolId: agent.modelPoolId,
    });
    expect(client.chatApiKeyId).toBe(keyless.id);
  },
);

poolTest(
  "disabled model pools retain the agent's direct-provider selection",
  async ({ pooledAgent }) => {
    config.llmProxy.modelPoolsEnabled = false;
    const { agent, organizationId, ownerId, callerId } = pooledAgent;
    for (const userId of [ownerId, callerId]) {
      const selection = await resolveRunLlmSelection({
        agent,
        organizationId,
        userId,
      });
      expect(selection).toMatchObject({
        modelId: agent.modelId,
        selectedProvider: "github-copilot",
      });
      const client = createLLMModelForAgent({
        organizationId,
        userId,
        agentId: pooledAgent.agentId,
        model: selection.selectedModel,
        provider: selection.selectedProvider,
        agentLlmApiKeyId: selection.chatApiKeyId ?? agent.llmApiKeyId,
        modelPoolId: agent.modelPoolId,
      });
      if (userId === ownerId) {
        expect((await client).chatApiKeyId).toBe(agent.llmApiKeyId);
      } else {
        await expect(client).rejects.toBeInstanceOf(
          LlmProviderAuthRequiredError,
        );
      }
    }
  },
);

function member(providerApiKeyId: string, priority: number) {
  return {
    providerApiKeyId,
    modelId: "gpt-4.1",
    priority,
    weight: 1,
    enabled: true,
  };
}

function completion(content: string) {
  return {
    id: "fixture-completion",
    object: "chat.completion",
    created: 1,
    model: "gpt-4.1",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}
