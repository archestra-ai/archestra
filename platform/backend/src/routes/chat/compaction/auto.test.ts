import { generateText, jsonSchema, tool } from "ai";
import { vi } from "vitest";
import { ConversationCompactionModel, ModelModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { beforeEach, describe, expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import { compactMessagesForChat } from "./compact-messages";
import { estimateChatMessagesTokens } from "./message-text";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

vi.mock("@/secrets-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/secrets-manager")>();
  return { ...actual, getSecretValueForLlmProviderApiKey: vi.fn() };
});

const mockGenerateText = vi.mocked(generateText);

const LONG_TURN = "background detail ".repeat(200);
const SYSTEM_PROMPT = "You are the chat agent.";

const MESSAGES: ChatMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: `Plan the migration. ${LONG_TURN}` }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: `Here is the plan. ${LONG_TURN}` }],
  },
  {
    id: "u2",
    role: "user",
    parts: [{ type: "text", text: "Now write the rollback steps." }],
  },
];

function generated(text: string) {
  return { text, finishReason: "stop" } as Awaited<
    ReturnType<typeof generateText>
  >;
}

describe("compactMessagesForChat auto trigger", () => {
  let params: Parameters<typeof compactMessagesForChat>[0];

  beforeEach(
    async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
      makeConversation,
    }) => {
      vi.clearAllMocks();
      vi.mocked(getSecretValueForLlmProviderApiKey).mockResolvedValue(
        "test-secret-value",
      );

      const user = await makeUser();
      const organization = await makeOrganization();
      await makeMember(user.id, organization.id, { role: "admin" });
      const agent = await makeAgent({
        organizationId: organization.id,
        authorId: user.id,
        access: "personal",
      });
      const secret = await makeSecret({ secret: { apiKey: "vllm-key" } });
      const apiKey = await makeLlmProviderApiKey(organization.id, secret.id, {
        provider: "vllm",
        name: "vLLM",
      });
      const model = await ModelModel.create({
        externalId: "vllm/qwen3-32b",
        provider: "vllm",
        modelId: "qwen3-32b",
        description: "qwen3-32b",
        contextLength: 1_000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: false,
        ignored: false,
        lastSyncedAt: new Date(),
      });
      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId: organization.id,
        modelId: model.id,
        chatApiKeyId: apiKey.id,
      });

      params = {
        conversationId: conversation.id,
        organizationId: organization.id,
        userId: user.id,
        agentId: agent.id,
        provider: "vllm",
        selectedModel: "qwen3-32b",
        modelId: model.id,
        agentLlmApiKeyId: apiKey.id,
        messages: MESSAGES,
        systemPrompt: SYSTEM_PROMPT,
        trigger: "auto",
      };
    },
  );

  test("summarizes in context on the chat model and keeps the pending user turn", async () => {
    mockGenerateText.mockResolvedValue(generated("<summary>S1</summary>"));

    const result = await compactMessagesForChat(params);

    expect(result.status).toBe("created");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual(MESSAGES[2]);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toBe(SYSTEM_PROMPT);
    expect(call.model).toMatchObject({ modelId: "qwen3-32b" });
    expect(call.messages).toBeDefined();

    const stored = await ConversationCompactionModel.findLatestByConversation(
      params.conversationId,
    );
    expect(stored).toMatchObject({
      summary: "S1",
      trigger: "auto",
      compactedThroughMessageId: "a1",
      provider: "vllm",
      model: "qwen3-32b",
    });
    expect(result.compaction?.id).toBe(stored?.id);
  });

  test("falls back to the transcript summarizer when the in-context reply misses the tag and a retry would not fit", async () => {
    mockGenerateText
      .mockResolvedValueOnce(generated("no tags here"))
      .mockResolvedValueOnce(generated("<summary>S2</summary>"));

    const result = await compactMessagesForChat(params);

    expect(result.status).toBe("created");
    expect(result.compaction?.summary).toBe("S2");
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(typeof mockGenerateText.mock.calls[1][0].prompt).toBe("string");
  });

  test("retries in context with a correction turn when the retry fits the window", async () => {
    const task: ChatMessage = {
      id: "big-u1",
      role: "user",
      parts: [{ type: "text", text: `Task. ${LONG_TURN.repeat(100)}` }],
    };
    const pending: ChatMessage = {
      id: "big-u2",
      role: "user",
      parts: [{ type: "text", text: `Follow-up. ${LONG_TURN.repeat(25)}` }],
    };
    const total = estimateChatMessagesTokens({
      provider: "vllm",
      model: "qwen3-32b-wide",
      messages: [task, pending],
    });
    // just past the threshold, so the pending turn fits the recent tail
    const wideModel = await ModelModel.create({
      externalId: "vllm/qwen3-32b-wide",
      provider: "vllm",
      modelId: "qwen3-32b-wide",
      description: "qwen3-32b-wide",
      contextLength: Math.floor(total / 0.8),
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: false,
      ignored: false,
      lastSyncedAt: new Date(),
    });
    mockGenerateText
      .mockResolvedValueOnce(generated("no tags here"))
      .mockResolvedValueOnce(generated("<summary>S-RETRY</summary>"));

    const result = await compactMessagesForChat({
      ...params,
      selectedModel: "qwen3-32b-wide",
      modelId: wideModel.id,
      messages: [task, pending],
    });

    expect(result.status).toBe("created");
    expect(result.compaction?.summary).toBe("S-RETRY");
    expect(result.messages[1]).toEqual(pending);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockGenerateText.mock.calls[1][0].messages).toBeDefined();
  });

  test("summarizes an oversized tool call instead of keeping it in the tail", async () => {
    mockGenerateText.mockResolvedValue(generated("<summary>S-TOOL</summary>"));
    const toolCall: ChatMessage = {
      id: "a-tool",
      role: "assistant",
      parts: [
        {
          type: "tool-write_file",
          toolCallId: "call-1",
          state: "output-available",
          input: { path: "/plan.md", content: LONG_TURN.repeat(20) },
          output: "ok",
        },
      ],
    };

    const result = await compactMessagesForChat({
      ...params,
      messages: [MESSAGES[0], toolCall, MESSAGES[2]],
    });

    expect(result.status).toBe("created");
    expect(result.messages.slice(1)).toEqual([MESSAGES[2]]);
  });

  test("summarizes in context with the turn's tools available but never called", async () => {
    mockGenerateText.mockResolvedValue(generated("<summary>S-TOOLS</summary>"));
    const tools = {
      lookup: tool({
        description: "Look up a record.",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
      }),
    };

    const result = await compactMessagesForChat({ ...params, tools });

    expect(result.status).toBe("created");
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.tools).toBe(tools);
    expect(call.toolChoice).toBe("none");
  });

  test("keeps the recent exchange verbatim when it fits the tail budget", async () => {
    mockGenerateText.mockResolvedValue(generated("<summary>S-TAIL</summary>"));
    const recentExchange: ChatMessage[] = [
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "Done." }] },
      { id: "u3", role: "user", parts: [{ type: "text", text: "Thanks." }] },
    ];

    const result = await compactMessagesForChat({
      ...params,
      messages: [...MESSAGES, ...recentExchange],
    });

    expect(result.status).toBe("created");
    expect(result.messages.slice(1)).toEqual([MESSAGES[2], ...recentExchange]);
    const stored = await ConversationCompactionModel.findLatestByConversation(
      params.conversationId,
    );
    expect(stored?.compactedThroughMessageId).toBe("a1");
  });

  test("falls back to the transcript summarizer when the in-context call fails", async () => {
    mockGenerateText
      .mockRejectedValueOnce(new Error("provider rejected"))
      .mockResolvedValueOnce(generated("<summary>S3</summary>"));

    const result = await compactMessagesForChat(params);

    expect(result.status).toBe("created");
    expect(result.compaction?.summary).toBe("S3");
    const fallbackCall = mockGenerateText.mock.calls[1][0];
    expect(typeof fallbackCall.prompt).toBe("string");
    expect(fallbackCall.messages).toBeUndefined();
  });

  test("reports a failure and sends the uncompacted history when every summarizer fails", async () => {
    mockGenerateText.mockRejectedValue(new Error("provider down"));

    const result = await compactMessagesForChat(params);

    expect(result).toMatchObject({
      status: "failed",
      reason: "summary_generation_failed",
      compaction: null,
      messages: MESSAGES,
    });
    expect(
      await ConversationCompactionModel.findLatestByConversation(
        params.conversationId,
      ),
    ).toBeNull();
  });

  test("stores nothing when the summary would not shrink the history", async () => {
    mockGenerateText.mockResolvedValue(
      generated(`<summary>${LONG_TURN.repeat(3)}</summary>`),
    );

    const result = await compactMessagesForChat(params);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "not_beneficial",
      messages: MESSAGES,
    });
    expect(
      await ConversationCompactionModel.findLatestByConversation(
        params.conversationId,
      ),
    ).toBeNull();
  });

  test("applies the stored summary on the next turn without summarizing again", async () => {
    mockGenerateText.mockResolvedValue(generated("<summary>S4</summary>"));
    await compactMessagesForChat(params);
    mockGenerateText.mockClear();

    const nextTurn = await compactMessagesForChat({
      ...params,
      messages: [
        ...MESSAGES,
        { id: "a2", role: "assistant", parts: [{ type: "text", text: "ok" }] },
        { id: "u3", role: "user", parts: [{ type: "text", text: "thanks" }] },
      ],
    });

    expect(nextTurn.status).toBe("existing");
    expect(nextTurn.reason).toBe("using_existing_summary");
    expect(nextTurn.messages.map((message) => message.id)).toEqual([
      undefined,
      "u2",
      "a2",
      "u3",
    ]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
