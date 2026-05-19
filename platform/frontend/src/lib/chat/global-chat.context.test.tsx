import type { UIMessage } from "@ai-sdk/react";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider, useGlobalChat } from "./global-chat.context";

const mocks = vi.hoisted(() => ({
  addToolApprovalResponse: vi.fn(),
  addToolResult: vi.fn(),
  invalidateQueries: vi.fn(),
  mutate: vi.fn(),
  regenerate: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  stop: vi.fn(),
  useChat: vi.fn(),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: mocks.useChat,
}));

vi.mock("ai", () => ({
  DefaultChatTransport: vi.fn(),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(() => true),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
  }),
}));

const conversationMock = vi.hoisted(() => ({
  data: { title: null as string | null } as { title: string | null } | null,
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useGenerateConversationTitle: () => ({
    isPending: false,
    mutate: mocks.mutate,
  }),
  useConversation: () => ({ data: conversationMock.data }),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: {
      fullWhiteLabeling: false,
    },
  },
}));

describe("ChatProvider retries", () => {
  let chatOptions: Parameters<typeof mocks.useChat>[0] | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    chatOptions = undefined;
    const messages: UIMessage[] = [];
    mocks.useChat.mockImplementation((options) => {
      chatOptions = options;
      return {
        addToolApprovalResponse: mocks.addToolApprovalResponse,
        addToolResult: mocks.addToolResult,
        error: undefined,
        messages,
        regenerate: mocks.regenerate,
        sendMessage: mocks.sendMessage,
        setMessages: mocks.setMessages,
        status: "ready",
        stop: mocks.stop,
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not auto-retry structured backend chat errors", async () => {
    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    vi.useFakeTimers();
    act(() => {
      chatOptions?.onError?.(
        new Error(
          JSON.stringify({
            code: "server_error",
            isRetryable: true,
            message: "An unexpected error occurred. Please try again.",
          }),
        ),
      );
      vi.advanceTimersByTime(2000);
    });

    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it("still auto-retries transport errors that likely did not reach the backend", async () => {
    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    vi.useFakeTimers();
    act(() => {
      chatOptions?.onError?.(new Error("Failed to fetch"));
      vi.advanceTimersByTime(1500);
    });

    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
  });
});

describe("ChatProvider auto title generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationMock.data = { title: null };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // An agent swap inserts a tool-only assistant message and an auto-poke user
  // message into the first exchange, so the first exchange spans two user and
  // two assistant messages, none of which carry assistant text.
  const swapMessages: UIMessage[] = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Show me the Archestra PM board" }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-swap_agent",
          toolCallId: "t1",
          state: "output-available",
          input: {},
          output: {},
        },
      ],
    } as unknown as UIMessage,
    {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "(poke)" }],
    },
    {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "tool-board",
          toolCallId: "t2",
          state: "output-available",
          input: {},
          output: {},
        },
      ],
    } as unknown as UIMessage,
  ];

  it("titles an untitled chat after a tool-only agent-swap exchange", async () => {
    mocks.useChat.mockImplementation((options) => {
      return {
        addToolApprovalResponse: mocks.addToolApprovalResponse,
        addToolResult: mocks.addToolResult,
        error: undefined,
        messages: swapMessages,
        regenerate: mocks.regenerate,
        sendMessage: mocks.sendMessage,
        setMessages: mocks.setMessages,
        status: "ready",
        stop: mocks.stop,
        _options: options,
      };
    });

    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({ id: "conversation-1" }),
    );
  });

  it("does not regenerate a title the conversation already has", async () => {
    conversationMock.data = { title: "Existing title" };
    mocks.useChat.mockImplementation(() => ({
      addToolApprovalResponse: mocks.addToolApprovalResponse,
      addToolResult: mocks.addToolResult,
      error: undefined,
      messages: swapMessages,
      regenerate: mocks.regenerate,
      sendMessage: mocks.sendMessage,
      setMessages: mocks.setMessages,
      status: "ready",
      stop: mocks.stop,
    }));

    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});

function RegisterChatSession() {
  const { registerSession } = useGlobalChat();

  useEffect(() => {
    registerSession({ conversationId: "conversation-1" });
  }, [registerSession]);

  return null;
}
