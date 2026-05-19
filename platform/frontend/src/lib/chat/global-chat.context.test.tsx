import type { UIMessage } from "@ai-sdk/react";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider, useGlobalChat } from "./global-chat.context";

type ChatSessionSnapshot = ReturnType<
  ReturnType<typeof useGlobalChat>["getSession"]
>;

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

  it("updates live context token estimate from usage and compaction data", async () => {
    const latestSessionRef: { current: ChatSessionSnapshot } = {
      current: undefined,
    };

    render(
      <ChatProvider>
        <RegisterChatSession />
        <CaptureChatSession
          onSession={(session) => {
            latestSessionRef.current = session;
          }}
        />
      </ChatProvider>,
    );

    await waitFor(() => expect(latestSessionRef.current).toBeDefined());

    act(() => {
      chatOptions?.onData?.({
        type: "data-token-usage",
        data: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.contextTokensUsed).toBe(120),
    );

    act(() => {
      chatOptions?.onData?.({
        type: "data-context-compaction-finish",
        data: {
          compactionId: "compaction-1",
          originalTokenEstimate: 120,
          compactedTokenEstimate: 35,
        },
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.contextTokensUsed).toBe(35),
    );
    expect(latestSessionRef.current?.contextCompaction.lastCompaction).toEqual({
      compactionId: "compaction-1",
      originalTokenEstimate: 120,
      compactedTokenEstimate: 35,
    });
  });
});

function RegisterChatSession() {
  const { registerSession } = useGlobalChat();

  useEffect(() => {
    registerSession({ conversationId: "conversation-1" });
  }, [registerSession]);

  return null;
}

function CaptureChatSession({
  onSession,
}: {
  onSession: (session: ChatSessionSnapshot) => void;
}) {
  const { getSession } = useGlobalChat();
  const session = getSession("conversation-1");

  useEffect(() => {
    onSession(session);
  }, [onSession, session]);

  return null;
}
