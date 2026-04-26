import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useChatLifecycle } from "../_hooks/use-chat-lifecycle";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  fetchConversationEnabledTools: vi.fn(),
  getOAuthReauthChatResume: vi.fn(),
  clearOAuthReauthChatResume: vi.fn(),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  fetchConversationEnabledTools: mocks.fetchConversationEnabledTools,
  useUpdateConversationEnabledTools: () => ({ mutate: mocks.mutate }),
}));

vi.mock("@/lib/auth/oauth-session", () => ({
  getOAuthReauthChatResume: mocks.getOAuthReauthChatResume,
  clearOAuthReauthChatResume: mocks.clearOAuthReauthChatResume,
}));

describe("useChatLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOAuthReauthChatResume.mockReturnValue(null);
  });

  test("sends the pending initial prompt exactly once when the new conversation session is ready", () => {
    const sendMessage = vi.fn();
    const selectConversation = vi.fn();
    const createInitialConversation = vi.fn((onSuccess) => {
      onSuccess?.({ id: "conversation-1" });
      return true;
    });

    const { result, rerender } = renderHook(
      (props: {
        conversationId?: string;
        conversation?: { id: string; messages: unknown[] } | null;
        messagesLength: number;
      }) =>
        useChatLifecycle({
          ...makeParams({
            sendMessage,
            selectConversation,
            createInitialConversation,
          }),
          ...props,
        }),
      {
        initialProps: {
          conversationId: undefined,
          conversation: null,
          messagesLength: 0,
        } as {
          conversationId?: string;
          conversation?: { id: string; messages: unknown[] } | null;
          messagesLength: number;
        },
      },
    );

    act(() => {
      result.current.submitInitialMessage({ text: "Hello", files: [] });
    });

    expect(selectConversation).toHaveBeenCalledWith("conversation-1");

    rerender({
      conversationId: "conversation-1",
      conversation: { id: "conversation-1", messages: [] },
      messagesLength: 0,
    });
    rerender({
      conversationId: "conversation-1",
      conversation: { id: "conversation-1", messages: [] },
      messagesLength: 0,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
      metadata: { createdAt: expect.any(String) },
    });
  });

  test("auto-sends URL user_prompt by creating a conversation once", () => {
    const sendMessage = vi.fn();
    const selectConversation = vi.fn();
    const createInitialConversation = vi.fn((onSuccess) => {
      onSuccess?.({ id: "conversation-1" });
      return true;
    });

    const { rerender } = renderHook(
      (props: { conversationId?: string }) =>
        useChatLifecycle({
          ...makeParams({
            initialUserPrompt: "From URL",
            sendMessage,
            selectConversation,
            createInitialConversation,
          }),
          ...props,
        }),
      { initialProps: { conversationId: undefined } },
    );

    expect(createInitialConversation).toHaveBeenCalledTimes(1);
    expect(selectConversation).toHaveBeenCalledWith("conversation-1");

    rerender({ conversationId: undefined });
    expect(createInitialConversation).toHaveBeenCalledTimes(1);
  });

  test("resumes OAuth reauth message only when the matching conversation is ready", () => {
    const sendMessage = vi.fn();
    mocks.getOAuthReauthChatResume.mockReturnValue({
      conversationId: "conversation-1",
      message: "Resume after auth",
    });

    renderHook(() =>
      useChatLifecycle(
        makeParams({
          conversationId: "conversation-1",
          sendMessage,
        }),
      ),
    );

    expect(mocks.clearOAuthReauthChatResume).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      role: "user",
      parts: [{ type: "text", text: "Resume after auth" }],
      metadata: { createdAt: expect.any(String) },
    });
  });
});

function makeParams(
  overrides: Partial<Parameters<typeof useChatLifecycle>[0]> = {},
): Parameters<typeof useChatLifecycle>[0] {
  return {
    conversationId: undefined,
    conversation: null,
    messagesLength: 0,
    status: "ready",
    sendMessage: vi.fn(),
    setMessages: vi.fn(),
    initialUserPrompt: undefined,
    initialAgentId: "agent-1",
    isCreateConversationPending: false,
    isPlaywrightSetupVisible: false,
    createInitialConversation: vi.fn(() => true),
    selectConversation: vi.fn(),
    queryClient: {
      setQueryData: vi.fn(),
    } as never,
    ...overrides,
  };
}
