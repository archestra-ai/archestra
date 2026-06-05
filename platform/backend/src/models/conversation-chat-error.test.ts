import { ChatErrorCode, type ChatErrorResponse } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import ConversationChatErrorModel from "./conversation-chat-error";

describe("ConversationChatErrorModel", () => {
  test("returns valid responses unchanged", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id);
    const input: ChatErrorResponse = {
      code: ChatErrorCode.RateLimit,
      message: "Slow down",
      isRetryable: true,
    };

    const result = await createErrorAndRead({
      conversationId: conversation.id,
      error: input,
    });

    expect(result).toEqual(input);
  });

  test("coerces non-string originalError.message to a string", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id);
    const input = {
      code: ChatErrorCode.ServerError,
      message: "Boom",
      isRetryable: true,
      originalError: {
        message: { nested: "object" } as unknown as string,
      },
    } as ChatErrorResponse;

    const result = await createErrorAndRead({
      conversationId: conversation.id,
      error: input,
    });

    expect(result.originalError?.message).toBe('{"nested":"object"}');
    expect(result.code).toBe(ChatErrorCode.ServerError);
  });

  test("falls back to a minimal valid response for non-enum code", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id);
    const input = {
      code: "not-a-real-code",
      message: "Custom",
      isRetryable: true,
    } as unknown as ChatErrorResponse;

    const result = await createErrorAndRead({
      conversationId: conversation.id,
      error: input,
    });

    expect(result.code).toBe(ChatErrorCode.Unknown);
    expect(result.message).toBe("Custom");
    expect(result.isRetryable).toBe(false);
  });

  test("falls back when isRetryable is not a boolean", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id);
    const input = {
      code: ChatErrorCode.Unknown,
      message: "Hi",
      isRetryable: "yes",
    } as unknown as ChatErrorResponse;

    const result = await createErrorAndRead({
      conversationId: conversation.id,
      error: input,
    });

    expect(result).toEqual({
      code: ChatErrorCode.Unknown,
      message: "Hi",
      isRetryable: false,
    });
  });

  test("stringifies top-level message when it isn't a string", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id);
    const input = {
      code: "bogus",
      message: { a: 1 },
      isRetryable: true,
    } as unknown as ChatErrorResponse;

    const result = await createErrorAndRead({
      conversationId: conversation.id,
      error: input,
    });

    expect(result.code).toBe(ChatErrorCode.Unknown);
    expect(result.message).toContain('"a":1');
  });
});

async function createErrorAndRead(params: {
  conversationId: string;
  error: ChatErrorResponse;
}): Promise<ChatErrorResponse> {
  await ConversationChatErrorModel.create(params);
  const [chatError] = await ConversationChatErrorModel.findByConversation(
    params.conversationId,
  );
  return chatError.error;
}
