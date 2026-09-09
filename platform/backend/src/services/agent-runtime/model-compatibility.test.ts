import type { SupportedProvider } from "@archestra/shared";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { expect, test } from "@/test";
import { preflightAgentRuntimeModelCompatibility } from "./model-compatibility";

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
      runtime: { command: null, inferenceProtocol: "anthropic" },
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
      runtime: { command: null, inferenceProtocol: "anthropic" },
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
