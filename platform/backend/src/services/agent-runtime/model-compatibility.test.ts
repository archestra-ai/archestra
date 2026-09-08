import type { SupportedProvider } from "@archestra/shared";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import { A2AProtocolRole } from "@/agents/a2a/a2a-protocol";
import config from "@/config";
import {
  A2AContextModel,
  A2AMessageModel,
  A2ATaskModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { expect, test } from "@/test";
import type { Agent, ResolvedAgentRuntime } from "@/types";
import { preflightAgentRuntimeModelCompatibility } from "./model-compatibility";

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
  const previousRuntimeEnabled = config.agentRuntime.enabled;
  config.agentRuntime.enabled = true;
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
        agentId: agent.id,
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
    config.agentRuntime.enabled = previousRuntimeEnabled;
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
      runtime: { inferenceProtocol: "anthropic" },
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
  ["us.anthropic.claude-sonnet-4-6", true],
  ["anthropic.claude-sonnet-4-6", true],
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
      runtime: { inferenceProtocol: "anthropic" },
      agent,
      organizationId: organization.id,
      userId: user.id,
    }),
  ).resolves.toMatchObject({
    llm: { selectedProvider: "anthropic", selectedModel: model.modelId },
    selectedModel: { id: model.id },
  });
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
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    maxCostUsd: null,
    idleTimeoutMinutes: null,
  };
}
