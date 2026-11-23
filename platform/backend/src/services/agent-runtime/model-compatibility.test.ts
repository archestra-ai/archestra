import type { SupportedProvider } from "@archestra/shared";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import { A2AProtocolRole } from "@/agents/a2a/a2a-protocol";
import config from "@/config";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import {
  A2AContextModel,
  A2AMessageModel,
  A2ATaskModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { afterEach, expect, test, vi } from "@/test";
import type { Agent, ResolvedAgentRuntime } from "@/types";
import { kubernetesAgentRuntimeBackendDriver } from "./backends/kubernetes";
import {
  getResolvedAgentRuntimeModelCompatibility,
  preflightAgentRuntimeModelCompatibility,
} from "./model-compatibility";

afterEach(() => vi.restoreAllMocks());

test("refuses an incompatible Gemini runtime before creating a detached task", async ({
  makeAgent,
  makeAdmin,
  makeLlmProviderApiKey,
  makeMember,
  makeOrganization,
  makeSecret,
}) => {
  const organization = await makeOrganization();
  const user = await makeAdmin();
  await makeMember(user.id, organization.id, { role: "admin" });
  const { model, providerKey } = await createModelSelection({
    organizationId: organization.id,
    provider: "gemini",
    modelId: "gemini-preflight-test",
    makeSecret,
    makeLlmProviderApiKey,
  });
  const agent = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "agent",
    modelId: model.id,
    llmApiKeyId: providerKey.id,
    runtime: agentRuntime("anthropic"),
  });
  const sandboxInstalled = vi
    .spyOn(agentSandboxApi, "isInstalled", "get")
    .mockReturnValue(true);
  vi.spyOn(
    kubernetesAgentRuntimeBackendDriver,
    "assertReady",
  ).mockResolvedValue();
  const actor = {
    id: user.id,
    kind: "user" as const,
    organizationId: organization.id,
  };
  const originalContextCount = await A2AContextModel.getTotalCount();
  const originalMessageCount = await A2AMessageModel.getTotalCount();

  try {
    await expect(
      new A2AManager({ taskMode: "full" }).sendMessage({
        actor,
        agentId: agent.id,
        request: {
          message: {
            messageId: crypto.randomUUID(),
            role: A2AProtocolRole.User,
            parts: [{ text: "Start a task" }],
          },
        },
        taskRun: { createTask: true, detached: true },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Anthropic API"),
    });
    await expect(
      A2ATaskModel.listForActor({
        actorKind: "user",
        actorId: user.id,
        agentIds: [agent.id],
        pageSize: 10,
      }),
    ).resolves.toMatchObject({ totalSize: 0 });
    expect(await A2AContextModel.getTotalCount()).toBe(originalContextCount);
    expect(await A2AMessageModel.getTotalCount()).toBe(originalMessageCount);

    const context = await A2AContextModel.create({
      actorKind: actor.kind,
      actorId: actor.id,
    });
    await expect(
      new A2AManager({ taskMode: "full" }).sendMessage({
        actor,
        agentId: agent.id,
        request: {
          message: {
            messageId: crypto.randomUUID(),
            contextId: context.id,
            role: A2AProtocolRole.User,
            parts: [{ text: "Reject without appending" }],
          },
        },
        taskRun: { createTask: true, detached: true },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await A2AMessageModel.findByContextId(context.id)).toEqual([]);
  } finally {
    sandboxInstalled.mockRestore();
  }
});

test("rejects a Bedrock model for an Anthropic runtime image", async ({
  makeAgent,
  makeAdmin,
  makeLlmProviderApiKey,
  makeMember,
  makeOrganization,
  makeSecret,
}) => {
  const organization = await makeOrganization();
  const user = await makeAdmin();
  await makeMember(user.id, organization.id, { role: "admin" });
  const { model, providerKey } = await createModelSelection({
    organizationId: organization.id,
    provider: "bedrock",
    modelId: "anthropic.claude-preflight-test",
    makeSecret,
    makeLlmProviderApiKey,
  });
  const agent = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "agent",
    modelId: model.id,
    llmApiKeyId: providerKey.id,
  });

  await expect(
    preflightAgentRuntimeModelCompatibility({
      runtime: {
        command: null,
        inferenceProtocol: "anthropic",
        image: "agent-image:dev",
        accountLock: null,
      },
      agent,
      organizationId: organization.id,
      userId: user.id,
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining("Anthropic API"),
  });
});

test.for([
  ["anthropic.claude-sonnet-4-6", true],
  ["us.anthropic.claude-sonnet-4-6", true],
  [
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6",
    true,
  ],
  ["amazon.nova-pro-v1:0", false],
] as const)("checks Claude Code compatibility for Bedrock model %s", async ([
  modelId,
  compatible,
], {
  makeAgent,
  makeAdmin,
  makeLlmProviderApiKey,
  makeMember,
  makeOrganization,
  makeSecret,
}) => {
  const organization = await makeOrganization();
  const user = await makeAdmin();
  await makeMember(user.id, organization.id, { role: "admin" });
  const { model, providerKey } = await createModelSelection({
    organizationId: organization.id,
    provider: "bedrock",
    modelId,
    makeSecret,
    makeLlmProviderApiKey,
  });
  const agent = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "agent",
    modelId: model.id,
    llmApiKeyId: providerKey.id,
  });
  const result = preflightAgentRuntimeModelCompatibility({
    runtime: {
      inferenceProtocol: "anthropic",
      command: ["archestra-claude-code"],
      image: "agent-image:dev",
      accountLock: null,
    },
    agent,
    organizationId: organization.id,
    userId: user.id,
  });
  if (compatible)
    await expect(result).resolves.toMatchObject({
      llm: { selectedProvider: "bedrock", selectedModel: modelId },
    });
  else
    await expect(result).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("requires a Claude model"),
    });
});

test("accepts an inherited compatible organization default model", async ({
  makeAgent,
  makeAdmin,
  makeLlmProviderApiKey,
  makeMember,
  makeOrganization,
  makeSecret,
}) => {
  const organization = await makeOrganization();
  const user = await makeAdmin();
  await makeMember(user.id, organization.id, { role: "admin" });
  const { model, providerKey } = await createModelSelection({
    organizationId: organization.id,
    provider: "anthropic",
    modelId: "claude-preflight-test",
    makeSecret,
    makeLlmProviderApiKey,
  });
  await OrganizationModel.patch(organization.id, {
    defaultModelId: model.id,
    defaultLlmApiKeyId: providerKey.id,
  });
  const agent = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "agent",
    modelId: null,
    llmApiKeyId: null,
  });

  await expect(
    preflightAgentRuntimeModelCompatibility({
      runtime: {
        command: null,
        inferenceProtocol: "anthropic",
        image: "agent-image:dev",
        accountLock: null,
      },
      agent,
      organizationId: organization.id,
      userId: user.id,
    }),
  ).resolves.toMatchObject({
    llm: { selectedProvider: "anthropic", selectedModel: model.modelId },
    selectedModel: { id: model.id },
  });
});

test("uses provider credentials after switching away from the Claude Code runtime", async ({
  makeAgent,
  makeAdmin,
  makeLlmProviderApiKey,
  makeMember,
  makeOrganization,
  makeSecret,
}) => {
  const organization = await makeOrganization();
  const user = await makeAdmin();
  await makeMember(user.id, organization.id, { role: "admin" });
  const { model, providerKey } = await createModelSelection({
    organizationId: organization.id,
    provider: "anthropic",
    modelId: "claude-preflight-test",
    makeSecret,
    makeLlmProviderApiKey,
  });
  const agent = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "agent",
    modelId: model.id,
    llmApiKeyId: providerKey.id,
  });

  await expect(
    preflightAgentRuntimeModelCompatibility({
      runtime: {
        command: ["archestra-claude-code-runtime"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "subscription", model: "sonnet" },
        image: "agent-image:dev",
        accountLock: null,
      },
      agent,
      organizationId: organization.id,
      userId: user.id,
    }),
  ).resolves.toMatchObject({
    usesClaudeCodeSubscription: true,
    llm: {
      chatApiKeyId: null,
      selectedProvider: "anthropic",
      selectedModel: "sonnet",
    },
  });
  await expect(
    preflightAgentRuntimeModelCompatibility({
      runtime: {
        command: ["custom-runtime"],
        inferenceProtocol: "anthropic",
        image: "agent-image:dev",
        accountLock: null,
      },
      agent,
      organizationId: organization.id,
      userId: user.id,
    }),
  ).resolves.toMatchObject({
    usesClaudeCodeSubscription: false,
    llm: {
      chatApiKeyId: providerKey.id,
      selectedProvider: "anthropic",
      selectedModel: model.modelId,
    },
  });
  const bedrock = await createModelSelection({
    organizationId: organization.id,
    provider: "bedrock",
    modelId: "us.anthropic.claude-preflight-test",
    makeSecret,
    makeLlmProviderApiKey,
  });
  await expect(
    preflightAgentRuntimeModelCompatibility({
      runtime: {
        command: ["archestra-claude-code-runtime"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "provider" },
        image: "agent-image:dev",
        accountLock: null,
      },
      agent: { modelId: bedrock.model.id, llmApiKeyId: bedrock.providerKey.id },
      organizationId: organization.id,
      userId: user.id,
    }),
  ).resolves.toMatchObject({
    usesClaudeCodeSubscription: false,
    claudeCodeCloudProvider: "bedrock",
  });
});

test("keeps main's result with no choice and no lock: Vertex on, maintained Claude, account unset, a non-Anthropic stored model", async ({
  makeAgent,
  makeAdmin,
  makeLlmProviderApiKey,
  makeMember,
  makeOrganization,
  makeSecret,
}) => {
  const organization = await makeOrganization();
  const user = await makeAdmin();
  await makeMember(user.id, organization.id, { role: "admin" });
  const { model, providerKey } = await createModelSelection({
    organizationId: organization.id,
    provider: "openai",
    modelId: "gpt-vertex-order-test",
    makeSecret,
    makeLlmProviderApiKey,
  });
  const agent = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "agent",
    modelId: model.id,
    llmApiKeyId: providerKey.id,
  });
  vi.spyOn(config.llm.anthropic.vertexAi, "enabled", "get").mockReturnValue(
    true,
  );

  // The subscription decision is made on the stored model (OpenAI: no
  // cloud), and the cloud is judged on the model the run then gets
  // (Anthropic through Vertex), as the launch spec on main did.
  await expect(
    getResolvedAgentRuntimeModelCompatibility({
      runtime: {
        command: ["archestra-claude-code"],
        inferenceProtocol: "anthropic",
        image: "agent-image:dev",
        accountLock: null,
      },
      agent,
      agentId: agent.id,
      organizationId: organization.id,
      userId: user.id,
    }),
  ).resolves.toMatchObject({
    usesClaudeCodeSubscription: true,
    claudeCodeCloudProvider: "vertex",
    llm: { selectedProvider: "anthropic", chatApiKeyId: null },
  });
});

test("a custom image uses the Claude subscription only when it declares it", async ({
  makeAgent,
  makeAdmin,
  makeLlmProviderApiKey,
  makeMember,
  makeOrganization,
  makeSecret,
}) => {
  const organization = await makeOrganization();
  const user = await makeAdmin();
  await makeMember(user.id, organization.id, { role: "admin" });
  const { model, providerKey } = await createModelSelection({
    organizationId: organization.id,
    provider: "anthropic",
    modelId: "claude-preflight-test",
    makeSecret,
    makeLlmProviderApiKey,
  });
  const agent = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "agent",
    modelId: model.id,
    llmApiKeyId: providerKey.id,
  });
  const check = (runtime: {
    command: string[];
    inferenceProtocol: "anthropic" | "openai_chat";
    claudeCode?: { authentication: "provider" | "subscription" };
  }) =>
    getResolvedAgentRuntimeModelCompatibility({
      runtime: { ...runtime, image: "agent-image:dev", accountLock: null },
      agent,
      organizationId: organization.id,
      userId: user.id,
    });

  await expect(
    check({
      command: ["custom-runtime"],
      inferenceProtocol: "anthropic",
      claudeCode: { authentication: "subscription" },
    }),
  ).resolves.toMatchObject({
    usesClaudeCodeSubscription: true,
    compatibility: { compatible: true },
    llm: { chatApiKeyId: null, selectedProvider: "anthropic" },
  });
  await expect(
    check({
      command: ["custom-runtime"],
      inferenceProtocol: "anthropic",
      claudeCode: { authentication: "provider" },
    }),
  ).resolves.toMatchObject({
    usesClaudeCodeSubscription: false,
    llm: { chatApiKeyId: providerKey.id, selectedModel: model.modelId },
  });
  await expect(
    check({
      command: ["custom-runtime"],
      inferenceProtocol: "openai_chat",
      claudeCode: { authentication: "subscription" },
    }),
  ).resolves.toMatchObject({
    usesClaudeCodeSubscription: true,
    compatibility: { compatible: false },
  });
  // A maintained runtime other than Claude Code never takes the subscription.
  await expect(
    check({
      command: ["archestra-opencode"],
      inferenceProtocol: "anthropic",
      claudeCode: { authentication: "subscription" },
    }),
  ).resolves.toMatchObject({ usesClaudeCodeSubscription: false });
});

async function createModelSelection(params: {
  organizationId: string;
  provider: SupportedProvider;
  modelId: string;
  makeSecret: (params: {
    secret: Record<string, unknown>;
  }) => Promise<{ id: string }>;
  makeLlmProviderApiKey: (
    organizationId: string,
    secretId: string,
    overrides: { provider: SupportedProvider },
  ) => Promise<{ id: string }>;
}) {
  const secret = await params.makeSecret({ secret: { apiKey: "test-key" } });
  const providerKey = await params.makeLlmProviderApiKey(
    params.organizationId,
    secret.id,
    { provider: params.provider },
  );
  const model = await ModelModel.create({
    externalId: `${params.provider}/${params.modelId}`,
    provider: params.provider,
    modelId: params.modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    lastSyncedAt: new Date(),
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
    model.id,
  ]);
  return { model, providerKey };
}

function agentRuntime(
  inferenceProtocol: ResolvedAgentRuntime["inferenceProtocol"],
): Agent["runtime"] {
  return {
    image: "example.invalid/runtime-agent:test",
    command: null,
    inferenceProtocol,
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    environment: null,
    credentials: null,
    ttlHours: null,
    maxCostUsd: null,
    idleTimeoutMinutes: null,
  };
}
