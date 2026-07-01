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
  clearChatErrors: vi.fn(),
  clearError: vi.fn(),
  getQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
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
  useMutation: () => ({
    mutateAsync: mocks.mutateAsync,
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
  useResolveChatMcpElicitation: () => ({
    isPending: false,
    mutateAsync: mocks.mutateAsync,
  }),
  useClearChatErrors: () => ({
    mutateAsync: mocks.clearChatErrors,
  }),
  useConversation: () => ({ data: conversationMock.data }),
  useConversationUpdatedCacheSync: () => {},
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
    // Model an in-flight replay by default: resumeStream() resolves only when
    // the replayed stream concludes, so a plain vi.fn() (returning undefined)
    // would misrepresent the SDK contract.
    mocks.resumeStream.mockReturnValue(new Promise(() => {}));
    chatOptions = undefined;
    const messages: UIMessage[] = [];
    mocks.useChat.mockImplementation((options) => {
      chatOptions = options;
      return {
        addToolApprovalResponse: mocks.addToolApprovalResponse,
        addToolResult: mocks.addToolResult,
        clearError: mocks.clearError,
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

  const networkError = () =>
    new Error(
      JSON.stringify({
        code: "network_error",
        isRetryable: true,
        message: "Connection error. Please check your network and try again.",
      }),
    );

  it("auto-retries a structured network_error", async () => {
    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    vi.useFakeTimers();
    act(() => {
      chatOptions?.onError?.(networkError());
      vi.advanceTimersByTime(1500);
    });

    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
  });

  it("clears the stale persisted error card after a network_error retry succeeds", async () => {
    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    vi.useFakeTimers();
    act(() => {
      chatOptions?.onError?.(networkError());
      vi.advanceTimersByTime(1500);
    });
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    await act(async () => {
      await chatOptions?.onFinish?.({ message: { parts: [] }, isAbort: false });
    });

    expect(mocks.clearChatErrors).toHaveBeenCalledWith({
      id: "conversation-1",
    });
  });

  it("does not clear persisted errors when a run succeeds after a non-retried error", async () => {
    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    // server_error is not silently auto-retried, so it stays terminal and leaves
    // no pending "clear on retry" intent for the next successful turn.
    act(() => {
      chatOptions?.onError?.(
        new Error(
          JSON.stringify({
            code: "server_error",
            isRetryable: true,
            message: "The AI provider is experiencing issues.",
          }),
        ),
      );
    });
    await act(async () => {
      await chatOptions?.onFinish?.({ message: { parts: [] }, isAbort: false });
    });

    expect(mocks.clearChatErrors).not.toHaveBeenCalled();
  });

  it("does not clear persisted errors on a later success after the retry reattaches with a 204", async () => {
    let resolveResume: (() => void) | undefined;
    mocks.resumeStream.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveResume = resolve;
        }),
    );

    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    // network_error auto-retries; its regenerate re-POSTs into the still-live run
    // and lands the duplicate-run 409, so the session reattaches via resumeStream.
    vi.useFakeTimers();
    act(() => {
      chatOptions?.onError?.(networkError());
      chatOptions?.onFinish?.({
        message: { parts: [] },
        isAbort: false,
        isError: true,
        isDisconnect: true,
      });
      vi.advanceTimersByTime(1500);
    });
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);

    act(() => {
      chatOptions?.onError?.(
        new Error("This conversation already has an active response."),
      );
      chatOptions?.onFinish?.({
        message: { parts: [] },
        isAbort: false,
        isError: true,
        isDisconnect: false,
      });
    });
    expect(mocks.resumeStream).toHaveBeenCalledTimes(1);

    // The run had already finished: resumeStream resolves 204 with no
    // onFinish/onError, concluding recovery.
    vi.useRealTimers();
    await act(async () => {
      resolveResume?.();
    });

    // A later unrelated turn succeeds — it must NOT clear the persisted error,
    // since the reattach already concluded the recovery.
    mocks.clearChatErrors.mockClear();
    await act(async () => {
      await chatOptions?.onFinish?.({ message: { parts: [] }, isAbort: false });
    });

    expect(mocks.clearChatErrors).not.toHaveBeenCalled();
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

  it("clears pending MCP elicitation when the stream finishes or terminally errors", async () => {
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
        type: "data-mcp-elicitation",
        data: {
          id: "00000000-0000-4000-8000-000000000001",
          conversationId: "conversation-1",
          toolName: "delivery__collect_delivery_details",
          message: "Please confirm delivery details",
          mode: "form",
        },
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.pendingMcpElicitation).toMatchObject({
        id: "00000000-0000-4000-8000-000000000001",
      }),
    );

    act(() => {
      chatOptions?.onFinish?.({ message: { parts: [] }, isAbort: false });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.pendingMcpElicitation).toBeNull(),
    );

    act(() => {
      chatOptions?.onData?.({
        type: "data-mcp-elicitation",
        data: {
          id: "00000000-0000-4000-8000-000000000002",
          conversationId: "conversation-1",
          toolName: "delivery__collect_delivery_details",
          message: "Please confirm delivery details",
          mode: "form",
        },
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.pendingMcpElicitation).toMatchObject({
        id: "00000000-0000-4000-8000-000000000002",
      }),
    );

    act(() => {
      chatOptions?.onError?.(
        new Error(JSON.stringify({ code: "server_error", message: "boom" })),
      );
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.pendingMcpElicitation).toBeNull(),
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
    // A cold 409 (no auto-recovery in flight) is a genuine concurrent submit —
    // reattaching would silently drop the message the user just typed.
    expect(mocks.resumeStream).not.toHaveBeenCalled();
    // The SDK error is cleared so the benign guard never renders as a hard
    // inline error panel — the toast is the only surfaced feedback.
    expect(mocks.clearError).toHaveBeenCalledTimes(1);
  });

  it("reattaches to the active run when our own auto-recovery retry hits the duplicate-run 409", async () => {
    render(
      <ChatProvider>
        <RegisterChatSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    // A transient network error severs the stream; the auto-retry re-POSTs
    // into the still-running backend run and gets the duplicate-run 409.
    // The AI SDK fires onFinish from a finally block right after onError
    // (with isError set) — replicate that sequence, since clearing the
    // recovery flag there would misclassify the upcoming 409 as a genuine
    // duplicate submit.
    vi.useFakeTimers();
    act(() => {
      chatOptions?.onError?.(new Error("Failed to fetch"));
      chatOptions?.onFinish?.({
        message: { parts: [] },
        isAbort: false,
        isError: true,
        isDisconnect: true,
      });
      vi.advanceTimersByTime(1500);
    });
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);

    act(() => {
      chatOptions?.onError?.(
        new Error("This conversation already has an active response."),
      );
      chatOptions?.onFinish?.({
        message: { parts: [] },
        isAbort: false,
        isError: true,
        isDisconnect: false,
      });
    });

    // The 409 was provoked by our own recovery retry: reattach to the live
    // run via the replay endpoint instead of telling the user to stop a
    // response they cannot see.
    expect(mocks.resumeStream).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("concludes recovery when the reattach finds the run already finished (204 no-op)", async () => {
    let resolveResume: (() => void) | undefined;
    mocks.resumeStream.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveResume = resolve;
        }),
    );

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

    await waitFor(() => expect(mocks.useChat).toHaveBeenCalled());

    // Sever the stream, let the auto-retry fire, and land its duplicate-run
    // 409 — the session is now reattaching via resumeStream().
    vi.useFakeTimers();
    act(() => {
      chatOptions?.onError?.(new Error("Failed to fetch"));
      chatOptions?.onFinish?.({
        message: { parts: [] },
        isAbort: false,
        isError: true,
        isDisconnect: true,
      });
      vi.advanceTimersByTime(1500);
    });
    act(() => {
      chatOptions?.onError?.(
        new Error("This conversation already has an active response."),
      );
      chatOptions?.onFinish?.({
        message: { parts: [] },
        isAbort: false,
        isError: true,
        isDisconnect: false,
      });
    });
    expect(mocks.resumeStream).toHaveBeenCalledTimes(1);
    expect(latestSessionRef.current?.isRecovering).toBe(true);

    // The run finished before the reattach landed: reconnectToStream gets the
    // 204 and the SDK resolves resumeStream() WITHOUT firing onFinish or
    // onError (ai@6 makeRequest early-returns on a null reconnect stream).
    await act(async () => {
      resolveResume?.();
    });

    // Recovery must conclude — a stuck flag would misroute the next genuine
    // concurrent submit's 409 into the reattach path (silently dropping the
    // typed message) and keep the frozen snapshot rendered indefinitely.
    expect(latestSessionRef.current?.isRecovering).toBe(false);
    expect(mocks.clearError).toHaveBeenCalled();

    // A later cold 409 is a genuine concurrent submit again: toast, no
    // reattach.
    act(() => {
      chatOptions?.onError?.(
        new Error("This conversation already has an active response."),
      );
    });
    expect(mocks.resumeStream).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This conversation already has a response in progress. Stop it before sending another message.",
    );
  });

  // NOTE: if the regression returns (regenerateUserMessage stops clearing the
  // restore-on-regression buffer), this test HANGS instead of failing an
  // assertion: the restore manufactures a new messages identity every render,
  // the session-sync effect re-fires on it, and the resulting render loop
  // never yields back to the test runner. A hung CI job here means this bug.
  it("does not resurrect the pre-edit assistant answer while edit-regenerate rebuilds it", async () => {
    const latestSessionRef: { current: ChatSessionSnapshot } = {
      current: undefined,
    };
    const userMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "bye" }],
    } as UIMessage;
    const oldAssistant = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Goodbye!" }],
    } as UIMessage;
    // Live SDK message list the useChat mock serves on every render.
    const liveMessages = { current: [userMessage, oldAssistant] };
    mocks.useChat.mockImplementation((options) => {
      chatOptions = options;
      return {
        addToolApprovalResponse: mocks.addToolApprovalResponse,
        addToolResult: mocks.addToolResult,
        clearError: mocks.clearError,
        error: undefined,
        messages: liveMessages.current,
        regenerate: mocks.regenerate,
        resumeStream: mocks.resumeStream,
        sendMessage: mocks.sendMessage,
        setMessages: mocks.setMessages,
        status: "ready",
        stop: mocks.stop,
      };
    });
    const editedUser = {
      ...userMessage,
      parts: [{ type: "text", text: "bye, edited" }],
    } as UIMessage;
    // Persisted thread returned by the edit mutation.
    mocks.mutateAsync.mockResolvedValue({
      messages: [editedUser, oldAssistant],
    });
    // Mirror the SDK contract: setMessages replaces the live list, and
    // regenerate({messageId}) synchronously truncates it up to and including
    // the user anchor before requesting (AbstractChat.regenerate slices
    // state.messages in the same task).
    mocks.setMessages.mockImplementation((next: UIMessage[]) => {
      liveMessages.current = next;
    });
    mocks.regenerate.mockImplementation(
      async ({ messageId }: { messageId: string }) => {
        const index = liveMessages.current.findIndex((m) => m.id === messageId);
        liveMessages.current = liveMessages.current.slice(0, index + 1);
      },
    );

    // Fresh JSX per render call — reusing one element identity makes React
    // bail out of re-rendering the subtree, so the regression renders below
    // would never reach the hook.
    const makeTree = () => (
      <ChatProvider>
        <RegisterChatSession />
        <CaptureChatSession
          onSession={(session) => {
            latestSessionRef.current = session;
          }}
        />
      </ChatProvider>
    );
    const { rerender } = render(makeTree());
    await waitFor(() =>
      expect(latestSessionRef.current?.messages).toHaveLength(2),
    );

    await act(async () => {
      await latestSessionRef.current?.regenerateUserMessage({
        messageId: "user-1",
        partIndex: 0,
        text: "bye, edited",
      });
    });
    expect(mocks.regenerate).toHaveBeenCalledWith({ messageId: "user-1" });

    // First render after the edit: regenerate has truncated the live list to
    // the user anchor.
    rerender(makeTree());

    // The regenerate stream then rebuilds the SAME assistant message from
    // empty. The restore-on-regression buffer must not resurrect the pre-edit
    // answer here — two writers fighting over one message is the update loop
    // that crashes the page (React #185, "Maximum update depth").
    liveMessages.current = [
      editedUser,
      {
        id: "assistant-1",
        role: "assistant",
        parts: [],
      } as unknown as UIMessage,
    ];
    rerender(makeTree());

    const lastMessage = latestSessionRef.current?.messages.at(-1);
    expect(lastMessage?.id).toBe("assistant-1");
    expect(lastMessage?.parts).toEqual([]);
  });

  it("marks the session as recovering while auto-retrying or reattaching, but not for terminal errors", async () => {
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
    expect(latestSessionRef.current?.isRecovering).toBe(false);

    // Transient network error → auto-retry scheduled → recovering: the UI
    // must not flash the error while the retry is in flight.
    act(() => {
      chatOptions?.onError?.(new Error("Failed to fetch"));
    });
    await waitFor(() =>
      expect(latestSessionRef.current?.isRecovering).toBe(true),
    );

    // Duplicate-run 409 → resumeStream reattach → still recovering.
    act(() => {
      chatOptions?.onError?.(
        new Error("This conversation already has an active response."),
      );
    });
    await waitFor(() =>
      expect(latestSessionRef.current?.isRecovering).toBe(true),
    );

    // Stream concluded → recovery over.
    act(() => {
      chatOptions?.onFinish?.({ message: { parts: [] }, isAbort: false });
    });
    await waitFor(() =>
      expect(latestSessionRef.current?.isRecovering).toBe(false),
    );

    // Terminal (structured, non-retryable) error → not recovering: the
    // error must surface.
    act(() => {
      chatOptions?.onError?.(
        new Error(JSON.stringify({ code: "server_error", message: "boom" })),
      );
    });
    await waitFor(() =>
      expect(latestSessionRef.current?.isRecovering).toBe(false),
    );
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

describe("context window breakdown state", () => {
  let chatOptions: Parameters<typeof mocks.useChat>[0] | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    chatOptions = undefined;
    // The real useChat returns a referentially-stable messages array between
    // renders when nothing changed. Returning a fresh [] from each mock call
    // instead makes stableMessages a new identity every render, which re-fires
    // the session-sync effect → notifySessionUpdate → re-render in an infinite
    // loop that hangs render(<ChatProvider>) and never exits the worker. Hoist
    // one stable empty array so the mock honors that contract.
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

  const validBreakdown = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextLength: 200_000,
    usedTokens: 84_200,
    freeTokens: 115_800,
    usedPercent: 42.1,
    estimatedInputCostUsd: 0.04,
    segments: [{ category: "messages", tokens: 84_200, items: [] }],
  } as const;

  it("stores a valid breakdown in session state when the event arrives", async () => {
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
        type: "data-context-window-breakdown",
        data: validBreakdown,
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.contextWindow).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usedTokens: 84_200,
      }),
    );
  });

  it("silently ignores a malformed breakdown payload without throwing", async () => {
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

    // First set a valid breakdown so we have something to check against.
    act(() => {
      chatOptions?.onData?.({
        type: "data-context-window-breakdown",
        data: validBreakdown,
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.contextWindow).not.toBeNull(),
    );

    // Now send a malformed payload — contextWindow should not change.
    act(() => {
      chatOptions?.onData?.({
        type: "data-context-window-breakdown",
        data: { provider: 42, usedTokens: "not-a-number" },
      });
    });

    // Give React a tick to flush any potential state update.
    await new Promise((r) => setTimeout(r, 0));

    // Still the previous valid value — malformed payload was dropped.
    expect(latestSessionRef.current?.contextWindow).toMatchObject({
      provider: "anthropic",
      usedTokens: 84_200,
    });
  });

  it("resets contextWindow to null when a new turn estimate arrives", async () => {
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

    // Establish a breakdown from a previous turn.
    act(() => {
      chatOptions?.onData?.({
        type: "data-context-window-breakdown",
        data: validBreakdown,
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.contextWindow).not.toBeNull(),
    );

    // A new turn-start estimate arrives — breakdown should clear immediately.
    act(() => {
      chatOptions?.onData?.({
        type: "data-context-window-estimate",
        data: { estimatedTokens: 10_000 },
      });
    });

    await waitFor(() =>
      expect(latestSessionRef.current?.contextWindow).toBeNull(),
    );

    // contextTokensUsed is seeded from the estimate.
    expect(latestSessionRef.current?.contextTokensUsed).toBe(10_000);
  });

  it("contextWindow is isolated per conversation and starts as null", async () => {
    // Register two separate conversations and confirm each starts with no breakdown.
    const sessionA: { current: ChatSessionSnapshot } = { current: undefined };
    const sessionB: { current: ChatSessionSnapshot } = { current: undefined };

    render(
      <ChatProvider>
        <RegisterChatSession conversationId="conv-a" />
        <RegisterChatSession conversationId="conv-b" />
        <CaptureChatSession
          conversationId="conv-a"
          onSession={(s) => {
            sessionA.current = s;
          }}
        />
        <CaptureChatSession
          conversationId="conv-b"
          onSession={(s) => {
            sessionB.current = s;
          }}
        />
      </ChatProvider>,
    );

    await waitFor(() => expect(sessionA.current).toBeDefined());
    await waitFor(() => expect(sessionB.current).toBeDefined());

    expect(sessionA.current?.contextWindow).toBeNull();
    expect(sessionB.current?.contextWindow).toBeNull();
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
  conversationId = "conversation-1",
  initialMessages,
}: {
  conversationId?: string;
  initialMessages?: UIMessage[];
}) {
  const { registerSession } = useGlobalChat();

  useEffect(() => {
    registerSession({ conversationId, initialMessages });
  }, [conversationId, initialMessages, registerSession]);

  return null;
}

function CaptureChatSession({
  conversationId = "conversation-1",
  onSession,
}: {
  conversationId?: string;
  onSession: (session: ChatSessionSnapshot) => void;
}) {
  const { getSession } = useGlobalChat();
  const session = getSession(conversationId);

  useEffect(() => {
    onSession(session);
  }, [onSession, session]);

  return null;
}
