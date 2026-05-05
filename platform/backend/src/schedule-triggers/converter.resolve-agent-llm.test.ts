import { vi } from "vitest";

const mockCreateDirectLLMModel = vi.hoisted(() => vi.fn(() => "mocked-model"));
const mockGenerateText = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    text: "LLM summarized standalone prompt",
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
);

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return {
    ...actual,
    createDirectLLMModel: mockCreateDirectLLMModel,
  };
});

import config from "@/config";
import ConversationModel from "@/models/conversation";
import { LimitValidationService } from "@/models/limit";
import MessageModel from "@/models/message";
import ModelModel from "@/models/model";
import { beforeEach, describe, expect, test } from "@/test";
import { scheduleTriggerConverterService } from "./converter";
import { configureScheduleConversionBuiltInForTests } from "./testing/configure-schedule-conversion-built-in";

describe("scheduleTriggerConverterService resolveAgentLlm (modelId → provider)", () => {
  beforeEach(() => {
    mockCreateDirectLLMModel.mockClear();
    mockGenerateText.mockClear();
  });

  test("uses provider from models table when org has a matching API key", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const modelId = `sched-resolve-openai-${crypto.randomUUID().slice(0, 8)}`;
    await ModelModel.create({
      externalId: `openai/${modelId}`,
      provider: "openai",
      modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.00001",
      completionPricePerToken: "0.00002",
      lastSyncedAt: new Date(),
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-test-openai" } });
    const openaiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "org",
    });
    await configureScheduleConversionBuiltInForTests({
      organizationId: org.id,
      llmApiKeyId: openaiKey.id,
      llmModel: modelId,
    });
    const agent = await makeInternalAgent({
      organizationId: org.id,
      llmModel: modelId,
    });
    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Resolve openai",
      selectedModel: modelId,
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Weekly digest" }],
      },
    });
    vi.spyOn(
      LimitValidationService,
      "checkLimitsBeforeRequest",
    ).mockResolvedValue(null);

    await scheduleTriggerConverterService.createFromConversation({
      conversationId: conversation.id,
      userId: user.id,
      organizationId: org.id,
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
      name: "Resolve test",
      agentId: agent.id,
    });

    expect(mockCreateDirectLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelName: modelId,
      }),
    );
  });

  test("skips earlier enum provider without key and uses one with a key", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const modelId = `sched-resolve-shared-${crypto.randomUUID().slice(0, 8)}`;
    await ModelModel.create({
      externalId: `openai/${modelId}`,
      provider: "openai",
      modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.00001",
      completionPricePerToken: "0.00002",
      lastSyncedAt: new Date(),
    });
    await ModelModel.create({
      externalId: `anthropic/${modelId}`,
      provider: "anthropic",
      modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000003",
      completionPricePerToken: "0.000015",
      lastSyncedAt: new Date(),
    });
    const secret = await makeSecret({
      secret: { apiKey: "sk-test-anthropic" },
    });
    const anthropicKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      scope: "org",
    });
    await configureScheduleConversionBuiltInForTests({
      organizationId: org.id,
      llmApiKeyId: anthropicKey.id,
      llmModel: modelId,
    });
    const agent = await makeInternalAgent({
      organizationId: org.id,
      llmModel: modelId,
    });
    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Resolve anthropic",
      selectedModel: modelId,
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Task" }],
      },
    });
    vi.spyOn(
      LimitValidationService,
      "checkLimitsBeforeRequest",
    ).mockResolvedValue(null);

    await scheduleTriggerConverterService.createFromConversation({
      conversationId: conversation.id,
      userId: user.id,
      organizationId: org.id,
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
      agentId: agent.id,
    });

    expect(mockCreateDirectLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelName: modelId,
      }),
    );
  });

  test("falls back to default chat provider when modelId is unknown", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const modelId = `unknown-model-${crypto.randomUUID().slice(0, 8)}`;
    await configureScheduleConversionBuiltInForTests({
      organizationId: org.id,
      llmApiKeyId: null,
      llmModel: modelId,
    });
    const agent = await makeInternalAgent({
      organizationId: org.id,
      llmModel: modelId,
    });
    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Fallback",
      selectedModel: modelId,
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      },
    });
    vi.spyOn(
      LimitValidationService,
      "checkLimitsBeforeRequest",
    ).mockResolvedValue(null);

    await scheduleTriggerConverterService.createFromConversation({
      conversationId: conversation.id,
      userId: user.id,
      organizationId: org.id,
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
      agentId: agent.id,
    });

    expect(mockCreateDirectLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: config.chat.defaultProvider,
        modelName: modelId,
      }),
    );
  });
});
