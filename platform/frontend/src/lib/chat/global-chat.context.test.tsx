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
  resumeStream: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  stop: vi.fn(),
  toastError: vi.fn(),
  useChat: vi.fn(),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: mocks.useChat,
}));

vi.mock("ai", () => ({
  DefaultChatTransport: vi.fn(),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(() => true),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
  }),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useGenerateConversationTitle: () => ({
    isPending: false,
    mutate: mocks.mutate,
  }),
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
        resumeStream: mocks.resumeStream,
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

  it("configures active-run reconnect URL and resumes when the last persisted message is from the user", async () => {
    const { DefaultChatTransport } = await import("ai");
    render(
      <ChatProvider>
        <RegisterChatSession
          initialMessages={[
            {
              id: "user-1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
          ]}
        />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    await waitFor(() => expect(mocks.resumeStream).toHaveBeenCalledTimes(1));
    expect(chatOptions?.resume).toBeUndefined();
    const transportOptions = vi.mocked(DefaultChatTransport).mock.calls[0]?.[0];
    expect(
      transportOptions?.prepareReconnectToStreamRequest?.({
        id: "conversation-1",
        api: "/api/chat",
        body: undefined,
        credentials: "include",
        headers: {},
        requestMetadata: undefined,
      }),
    ).toMatchObject({
      api: "/api/chat/conversations/conversation-1/active-run",
    });
  });

  it("shows a toast for duplicate active-run submits", async () => {
    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    act(() => {
      chatOptions?.onError?.(
        new Error("This conversation already has an active response."),
      );
    });

    expect(mocks.toastError).toHaveBeenCalledWith(
      "This conversation already has a response in progress. Stop it before sending another message.",
    );
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });
});

function RegisterChatSession({
  initialMessages,
}: {
  initialMessages?: UIMessage[];
}) {
  const { registerSession } = useGlobalChat();

  useEffect(() => {
    registerSession({ conversationId: "conversation-1", initialMessages });
  }, [initialMessages, registerSession]);

  return null;
}
