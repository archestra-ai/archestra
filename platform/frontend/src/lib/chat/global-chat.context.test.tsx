import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import { ChatProvider, useChatSession } from "./global-chat.context";

const useChatMock = vi.fn();
const useGenerateConversationTitleMock = vi.fn();
const invalidateQueriesMock = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  useChat: (...args: unknown[]) => useChatMock(...args),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: invalidateQueriesMock,
    }),
  };
});

vi.mock("@/lib/chat/chat.query", () => ({
  useGenerateConversationTitle: () => useGenerateConversationTitleMock(),
}));

vi.mock("@/lib/chat/chat-session-utils", () => ({
  restoreRenderableAssistantParts: ({
    nextMessages,
  }: {
    nextMessages: unknown[];
  }) => nextMessages,
}));

vi.mock("@/lib/chat/swap-agent.utils", () => ({
  extractSwapTargetAgentName: () => null,
  getRenderedToolName: () => null,
  getSwapToolShortName: () => null,
  hasSwapToolErrorInPart: () => false,
}));

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: {
      fullWhiteLabeling: false,
    },
  },
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

type UseChatOptions = Parameters<typeof useChatMock>[0];

describe("useChatSession", () => {
  let latestUseChatOptions: UseChatOptions | undefined;
  let useChatState: ReturnType<typeof createUseChatState>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

    useGenerateConversationTitleMock.mockReturnValue({
      isPending: false,
      mutate: vi.fn(),
    });

    useChatState = createUseChatState();
    latestUseChatOptions = undefined;

    useChatMock.mockImplementation((options: UseChatOptions) => {
      latestUseChatOptions = options;
      return useChatState;
    });
  });

  it("hydrates a persisted conversation error from localStorage", async () => {
    const conversationId = "conversation-1";
    localStorage.setItem(
      conversationStorageKeys(conversationId).error,
      JSON.stringify({
        code: "server_error",
        message: "Persisted provider failure",
        isRetryable: true,
      }),
    );

    const { result } = renderHook(
      () => useChatSession({ conversationId, enabled: true }),
      {
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => {
      expect(result.current?.error?.message).toContain(
        "Persisted provider failure",
      );
    });
  });

  it("keeps the last error during retries and clears it after a successful finish", async () => {
    const conversationId = "conversation-2";

    const { result } = renderHook(
      () => useChatSession({ conversationId, enabled: true }),
      {
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => {
      expect(result.current).not.toBeNull();
      expect(latestUseChatOptions).toBeDefined();
    });

    act(() => {
      latestUseChatOptions?.onError?.(
        new Error(
          JSON.stringify({
            code: "server_error",
            message: "Temporary backend failure",
            isRetryable: true,
          }),
        ),
      );
    });

    await waitFor(() => {
      expect(result.current?.error?.message).toContain(
        "Temporary backend failure",
      );
    });
    expect(
      localStorage.getItem(conversationStorageKeys(conversationId).error),
    ).toContain("Temporary backend failure");

    act(() => {
      useChatState.error = undefined;
      latestUseChatOptions?.onFinish?.({
        message: {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Recovered" }],
        },
      });
    });

    await waitFor(() => {
      expect(result.current?.error).toBeUndefined();
    });
    expect(
      localStorage.getItem(conversationStorageKeys(conversationId).error),
    ).toBeNull();
  });

  it("keeps showing the in-memory error when localStorage persistence fails", async () => {
    const conversationId = "conversation-3";
    const storageSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });

    const { result } = renderHook(
      () => useChatSession({ conversationId, enabled: true }),
      {
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => {
      expect(result.current).not.toBeNull();
      expect(latestUseChatOptions).toBeDefined();
    });

    act(() => {
      latestUseChatOptions?.onError?.(new Error("Storage-limited failure"));
    });

    await waitFor(() => {
      expect(result.current?.error?.message).toBe("Storage-limited failure");
    });
    expect(storageSpy).toHaveBeenCalledWith(
      conversationStorageKeys(conversationId).error,
      "Storage-limited failure",
    );

    storageSpy.mockRestore();
  });
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ChatProvider>{children}</ChatProvider>
    </QueryClientProvider>
  );
}

function createUseChatState() {
  return {
    messages: [],
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    status: "ready" as const,
    setMessages: vi.fn(),
    stop: vi.fn(),
    error: undefined as Error | undefined,
    addToolResult: vi.fn(),
    addToolApprovalResponse: vi.fn(),
  };
}
