import { vi } from "vitest";

const mockGenerateText = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    text: "LLM summarized standalone prompt",
    usage: { inputTokens: 10, outputTokens: 5 },
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
    createDirectLLMModel: vi.fn(() => "mocked-model"),
  };
});

import ConversationModel from "@/models/conversation";
import LimitModel, { LimitValidationService } from "@/models/limit";
import MessageModel from "@/models/message";
import { beforeEach, describe, expect, test } from "@/test";
import { scheduleTriggerConverterService } from "./converter";
import { configureScheduleConversionBuiltInForTests } from "./testing/configure-schedule-conversion-built-in";

describe("scheduleTriggerConverterService quota / limit integration", () => {
  beforeEach(() => {
    mockGenerateText.mockClear();
    mockGenerateText.mockResolvedValue({
      text: "LLM summarized standalone prompt",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  test("falls back to first user message when token cost limit blocks summarization", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await configureScheduleConversionBuiltInForTests({
      organizationId: org.id,
      llmModel: "gpt-4o",
    });
    const agent = await makeInternalAgent({
      organizationId: org.id,
      llmModel: "gpt-4o",
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Quota test",
      selectedModel: "gpt-4o",
    });

    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-user-1",
        role: "user",
        parts: [{ type: "text", text: "First user line for fallback" }],
      },
    });

    vi.spyOn(
      LimitValidationService,
      "checkLimitsBeforeRequest",
    ).mockResolvedValue(["refusal", "quota exceeded"] as [string, string]);

    const trigger =
      await scheduleTriggerConverterService.createFromConversation({
        conversationId: conversation.id,
        userId: user.id,
        organizationId: org.id,
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
        name: "Quota blocked summary",
        agentId: agent.id,
      });

    expect(trigger.messageTemplate).toBe("First user line for fallback");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("records token usage via LimitModel after successful summarization", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const { builtInId } = await configureScheduleConversionBuiltInForTests({
      organizationId: org.id,
      llmModel: "gpt-4o",
    });
    const agent = await makeInternalAgent({
      organizationId: org.id,
      llmModel: "gpt-4o",
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Usage test",
      selectedModel: "gpt-4o",
    });

    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-user-1",
        role: "user",
        parts: [{ type: "text", text: "Do something weekly" }],
      },
    });

    vi.spyOn(
      LimitValidationService,
      "checkLimitsBeforeRequest",
    ).mockResolvedValue(null);
    const updateSpy = vi
      .spyOn(LimitModel, "updateTokenLimitUsage")
      .mockResolvedValue(undefined);

    const trigger =
      await scheduleTriggerConverterService.createFromConversation({
        conversationId: conversation.id,
        userId: user.id,
        organizationId: org.id,
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
        name: "Usage recorded",
        agentId: agent.id,
      });

    expect(mockGenerateText).toHaveBeenCalled();
    expect(trigger.messageTemplate).toBe("LLM summarized standalone prompt");
    expect(updateSpy).toHaveBeenCalledWith("agent", builtInId, "gpt-4o", 10, 5);
  });

  test("still returns summarized prompt when updateTokenLimitUsage fails", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await configureScheduleConversionBuiltInForTests({
      organizationId: org.id,
      llmModel: "gpt-4o",
    });
    const agent = await makeInternalAgent({
      organizationId: org.id,
      llmModel: "gpt-4o",
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Resilient usage",
      selectedModel: "gpt-4o",
    });

    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-user-1",
        role: "user",
        parts: [{ type: "text", text: "Weekly report" }],
      },
    });

    vi.spyOn(
      LimitValidationService,
      "checkLimitsBeforeRequest",
    ).mockResolvedValue(null);
    vi.spyOn(LimitModel, "updateTokenLimitUsage").mockRejectedValue(
      new Error("limit_model_usage write failed"),
    );

    const trigger =
      await scheduleTriggerConverterService.createFromConversation({
        conversationId: conversation.id,
        userId: user.id,
        organizationId: org.id,
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
        name: "Resilient task",
        agentId: agent.id,
      });

    expect(trigger.messageTemplate).toBe("LLM summarized standalone prompt");
  });
});
