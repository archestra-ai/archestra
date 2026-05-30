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
  getQueryData: vi.fn(),
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
    getQueryData: mocks.getQueryData,
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

    // the indicator tracks prompt (input) occupancy, not input+output total
    await waitFor(() =>
      expect(latestSessionRef.current?.contextTokensUsed).toBe(100),
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

  it("updates live context tokens from auto compaction estimates", async () => {
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

    // the indicator tracks prompt (input) occupancy, not input+output total
    await waitFor(() =>
      expect(latestSessionRef.current?.contextTokensUsed).toBe(100),
    );

    act(() => {
      chatOptions?.onData?.({
        type: "data-context-compaction-finish",
        data: {
          trigger: "auto",
          compactionId: "compaction-1",
          originalTokenEstimate: 1_652_781,
          compactedTokenEstimate: 794_797,
        },
      });
    });

    await waitFor(() =>
      expect(
        latestSessionRef.current?.contextCompaction.lastCompaction,
      ).toEqual({
        trigger: "auto",
        compactionId: "compaction-1",
        originalTokenEstimate: 1_652_781,
        compactedTokenEstimate: 794_797,
      }),
    );
    expect(latestSessionRef.current?.contextTokensUsed).toBe(794_797);
  });

  it("seeds context tokens from the turn-start window estimate, then refines from per-step usage", async () => {
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

    // turn-start estimate seeds the indicator before the model responds
    act(() => {
      chatOptions?.onData?.({
        type: "data-context-window-estimate",
        data: { estimatedTokens: 542_000 },
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.contextTokensUsed).toBe(542_000),
    );

    // a per-step usage event then refines the seed with the provider's real
    // prompt size (input tokens), e.g. right after an auto-compaction drop
    act(() => {
      chatOptions?.onData?.({
        type: "data-token-usage",
        data: { inputTokens: 7_199, outputTokens: 86, totalTokens: 7_285 },
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.contextTokensUsed).toBe(7_199),
    );
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
    let chatOptions: Parameters<typeof mocks.useChat>[0] | undefined;

    mocks.useChat.mockImplementation((options) => {
      chatOptions = options;
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
      };
    });

    // Simulate the "instant title" set on conversation creation (first user message text)
    mocks.getQueryData.mockReturnValue({
      title: "Show me the Archestra PM board",
    });

    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    // Trigger onFinish to simulate the AI stream completing
    act(() => {
      chatOptions?.onFinish?.({
        message: swapMessages[swapMessages.length - 1],
        isAbort: false,
      });
    });

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith(
        { id: "conversation-1", regenerate: true },
        expect.any(Object),
      ),
    );
  });

  it("titles an existing untitled chat after the first settled exchange", async () => {
    let chatOptions: Parameters<typeof mocks.useChat>[0] | undefined;

    mocks.useChat.mockImplementation((options) => {
      chatOptions = options;
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
      };
    });
    mocks.getQueryData.mockReturnValue({ title: null });

    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    act(() => {
      chatOptions?.onFinish?.({
        message: swapMessages[swapMessages.length - 1],
        isAbort: false,
      });
    });

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith(
        { id: "conversation-1", regenerate: false },
        expect.any(Object),
      ),
    );
  });

  it("does not regenerate a title the conversation already has", async () => {
    let chatOptions: Parameters<typeof mocks.useChat>[0] | undefined;

    mocks.useChat.mockImplementation((options) => {
      chatOptions = options;
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
      };
    });
    mocks.getQueryData.mockReturnValue({ title: "Existing title" });

    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());
    act(() => {
      chatOptions?.onFinish?.({
        message: swapMessages[swapMessages.length - 1],
        isAbort: false,
      });
    });

    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("attempts automatic title generation only once", async () => {
    let chatOptions: Parameters<typeof mocks.useChat>[0] | undefined;

    mocks.useChat.mockImplementation((options) => {
      chatOptions = options;
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
      };
    });
    mocks.getQueryData.mockReturnValue({ title: null });

    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    act(() => {
      chatOptions?.onFinish?.({
        message: swapMessages[swapMessages.length - 1],
        isAbort: false,
      });
      chatOptions?.onFinish?.({
        message: swapMessages[swapMessages.length - 1],
        isAbort: false,
      });
    });

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
  });
});

describe("ChatProvider title animation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a title as animating and auto-clears it after the animation window", async () => {
    let markTitleAnimating: ((id: string) => void) | undefined;
    let animatingTitleIds: Set<string> = new Set();

    render(
      <ChatProvider>
        <CaptureTitleAnimation
          onValue={(value) => {
            markTitleAnimating = value.markTitleAnimating;
            animatingTitleIds = value.animatingTitleIds;
          }}
        />
      </ChatProvider>,
    );

    await waitFor(() => expect(markTitleAnimating).toBeDefined());

    vi.useFakeTimers();
    act(() => {
      markTitleAnimating?.("conversation-1");
    });
    expect(animatingTitleIds.has("conversation-1")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(animatingTitleIds.has("conversation-1")).toBe(false);
  });
});

function CaptureTitleAnimation({
  onValue,
}: {
  onValue: (value: {
    markTitleAnimating: (id: string) => void;
    animatingTitleIds: Set<string>;
  }) => void;
}) {
  const { markTitleAnimating, animatingTitleIds } = useGlobalChat();

  useEffect(() => {
    onValue({ markTitleAnimating, animatingTitleIds });
  }, [onValue, markTitleAnimating, animatingTitleIds]);

  return null;
}

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
