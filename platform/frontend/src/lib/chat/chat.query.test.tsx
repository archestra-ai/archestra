import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import {
  invalidateConversationFileQueries,
  mergeUpdatedConversationIntoCache,
  useConversation,
  useConversationEnabledTools,
  useConversationFiles,
  useConversations,
  useConversationUpdatedCacheSync,
  useKeepViewedConversationRead,
  useMarkConversationRead,
  useMemberDefaultModel,
} from "./chat.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getChatConversations: vi.fn(),
    getChatConversation: vi.fn(),
    getChatConversationFiles: vi.fn(),
    getMemberDefaultModel: vi.fn(),
    getConversationEnabledTools: vi.fn(),
    markChatConversationRead: vi.fn(),
  },
  PLAYWRIGHT_MCP_CATALOG_ID: "playwright-catalog-id",
  PLAYWRIGHT_MCP_SERVER_NAME: "playwright-mcp",
}));

const mockPathname = { value: "/chat" };
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname.value,
}));

const wsHandlers: Record<string, (msg: unknown) => void> = {};
vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: vi.fn(),
    subscribe: (type: string, handler: (msg: unknown) => void) => {
      wsHandlers[type] = handler;
      return () => delete wsHandlers[type];
    },
  },
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual("@/lib/utils");
  return {
    ...actual,
    handleApiError: vi.fn(),
  };
});

const mockedHandleApiError = vi.mocked(handleApiError);

type ErrorResult = {
  data: undefined;
  error: unknown;
  response?: { status: number };
};
const errorResult = (status?: number): ErrorResult => ({
  data: undefined,
  error: { message: "boom" },
  response: status === undefined ? undefined : { status },
});

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe("useConversations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(archestraApiSdk.getChatConversations).mockResolvedValue({
      data: [makeConversation()],
      error: undefined,
    } as Awaited<ReturnType<typeof archestraApiSdk.getChatConversations>>);
  });

  it("does not fetch while disabled", () => {
    renderHook(() => useConversations({ enabled: false }), {
      wrapper: createWrapper(),
    });

    expect(archestraApiSdk.getChatConversations).not.toHaveBeenCalled();
  });

  it("fetches once it becomes enabled after starting disabled", async () => {
    // Regression: the search palette mounts permanently with enabled=false,
    // so a cached empty result must not stick once the palette opens.
    const { result, rerender } = renderHook(
      ({ enabled }) => useConversations({ enabled }),
      { wrapper: createWrapper(), initialProps: { enabled: false } },
    );

    expect(archestraApiSdk.getChatConversations).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
    });
    expect(archestraApiSdk.getChatConversations).toHaveBeenCalledTimes(1);
  });
});

describe("useConversation error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([400, 404])("suppresses the toast for status %i", async (status) => {
    vi.mocked(archestraApiSdk.getChatConversation).mockResolvedValue(
      errorResult(status) as Awaited<
        ReturnType<typeof archestraApiSdk.getChatConversation>
      >,
    );

    const { result } = renderHook(() => useConversation("c1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeNull());
    expect(mockedHandleApiError).not.toHaveBeenCalled();
  });

  it("toasts for non-400/404 errors and returns null", async () => {
    vi.mocked(archestraApiSdk.getChatConversation).mockResolvedValue(
      errorResult(500) as Awaited<
        ReturnType<typeof archestraApiSdk.getChatConversation>
      >,
    );

    const { result } = renderHook(() => useConversation("c1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeNull());
    expect(mockedHandleApiError).toHaveBeenCalledTimes(1);
  });
});

describe("useMemberDefaultModel error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the null model/key fallback on an HTTP error", async () => {
    vi.mocked(archestraApiSdk.getMemberDefaultModel).mockResolvedValue(
      errorResult(500) as Awaited<
        ReturnType<typeof archestraApiSdk.getMemberDefaultModel>
      >,
    );

    const { result } = renderHook(() => useMemberDefaultModel(), {
      wrapper: createWrapper(),
    });

    await waitFor(() =>
      expect(result.current.data).toEqual({
        modelId: null,
        chatApiKeyId: null,
      }),
    );
    expect(mockedHandleApiError).toHaveBeenCalledTimes(1);
  });

  it("returns the fallback without throwing on a network error", async () => {
    vi.mocked(archestraApiSdk.getMemberDefaultModel).mockResolvedValue(
      errorResult(undefined) as Awaited<
        ReturnType<typeof archestraApiSdk.getMemberDefaultModel>
      >,
    );

    const { result } = renderHook(() => useMemberDefaultModel(), {
      wrapper: createWrapper(),
    });

    await waitFor(() =>
      expect(result.current.data).toEqual({
        modelId: null,
        chatApiKeyId: null,
      }),
    );
    expect(result.current.isError).toBe(false);
  });
});

describe("useConversationFiles error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    500,
    undefined,
  ])("returns null silently on error (status %s)", async (status) => {
    vi.mocked(archestraApiSdk.getChatConversationFiles).mockResolvedValue(
      errorResult(status) as Awaited<
        ReturnType<typeof archestraApiSdk.getChatConversationFiles>
      >,
    );

    const { result } = renderHook(() => useConversationFiles("c1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.isError).toBe(false);
    expect(mockedHandleApiError).not.toHaveBeenCalled();
  });
});

describe("useConversationEnabledTools status handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays silent and returns null on a 404", async () => {
    vi.mocked(archestraApiSdk.getConversationEnabledTools).mockResolvedValue(
      errorResult(404) as Awaited<
        ReturnType<typeof archestraApiSdk.getConversationEnabledTools>
      >,
    );

    const { result } = renderHook(() => useConversationEnabledTools("c1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeNull());
    expect(mockedHandleApiError).not.toHaveBeenCalled();
  });

  it("toasts and returns null on a non-404 error", async () => {
    vi.mocked(archestraApiSdk.getConversationEnabledTools).mockResolvedValue(
      errorResult(500) as Awaited<
        ReturnType<typeof archestraApiSdk.getConversationEnabledTools>
      >,
    );

    const { result } = renderHook(() => useConversationEnabledTools("c1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeNull());
    expect(mockedHandleApiError).toHaveBeenCalledTimes(1);
  });
});

describe("mergeUpdatedConversationIntoCache", () => {
  test("applies implicit model, provider, and key changes from an agent switch", () => {
    const oldConversation = makeConversation();
    const updatedConversation = {
      ...oldConversation,
      agentId: "agent-b",
      agent: {
        id: "agent-b",
        name: "Agent B",
        systemPrompt: null,
        agentType: "agent",
        toolExposureMode: "full",
        llmApiKeyId: "key-anthropic",
      },
      modelId: "model-claude",
      chatApiKeyId: "key-anthropic",
    } satisfies archestraApiTypes.UpdateChatConversationResponses["200"];

    const merged = mergeUpdatedConversationIntoCache(
      oldConversation,
      updatedConversation,
      {
        id: "conversation-1",
        agentId: "agent-b",
      },
    );

    expect(merged.agentId).toBe("agent-b");
    expect(merged.agent?.id).toBe("agent-b");
    expect(merged.modelId).toBe("model-claude");
    expect(merged.chatApiKeyId).toBe("key-anthropic");
  });

  test("keeps unrelated fields stable for a model-only update", () => {
    const oldConversation = makeConversation();
    const updatedConversation = {
      ...oldConversation,
      modelId: "model-gpt41",
    } satisfies archestraApiTypes.UpdateChatConversationResponses["200"];

    const merged = mergeUpdatedConversationIntoCache(
      oldConversation,
      updatedConversation,
      {
        id: "conversation-1",
        modelId: "model-gpt41",
      },
    );

    expect(merged.agentId).toBe("agent-a");
    expect(merged.chatApiKeyId).toBe("key-openai");
    expect(merged.modelId).toBe("model-gpt41");
  });
});

describe("invalidateConversationFileQueries", () => {
  test("refreshes the project Files panel for a project chat", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    invalidateConversationFileQueries(queryClient, {
      conversationId: "c1",
      projectId: "p1",
    });

    expect(spy).toHaveBeenCalledWith({
      queryKey: ["conversation-files", "c1"],
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["conversation", "c1"] });
    // The fix: a file created in a project chat must mark the project's Files
    // list stale so navigating to the project view refetches it.
    expect(spy).toHaveBeenCalledWith({
      queryKey: ["projects", "p1", "files"],
    });
  });

  test("leaves project queries untouched for a non-project chat", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    invalidateConversationFileQueries(queryClient, {
      conversationId: "c1",
      projectId: null,
    });

    expect(spy).toHaveBeenCalledWith({
      queryKey: ["conversation-files", "c1"],
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["conversation", "c1"] });
    // Only the two conversation keys — no `["projects", …]` invalidation that
    // would refetch an unrelated project's files for a plain chat.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

function makeConversation(): archestraApiTypes.GetChatConversationResponses["200"] {
  return {
    id: "conversation-1",
    userId: "user-1",
    organizationId: "org-1",
    agentId: "agent-a",
    chatApiKeyId: "key-openai",
    title: "Test",
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    modelId: null,
    hasCustomToolSelection: false,
    hooksDebugEnabled: false,
    todoList: null,
    artifact: null,
    projectId: null,
    origin: "user",
    pinnedAt: null,
    lastMessageAt: "2026-03-17T00:00:00.000Z",
    createdAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
    agent: {
      id: "agent-a",
      name: "Agent A",
      systemPrompt: null,
      agentType: "agent",
      toolExposureMode: "full",
      llmApiKeyId: "key-openai",
    },
    share: null,
    messages: [],
    chatErrors: [],
    compactions: [],
  };
}

describe("conversation read-state hooks", () => {
  const seededList = (...convs: Array<{ id: string; unread: boolean }>) =>
    convs.map((c) => ({ ...makeConversation(), id: c.id, unread: c.unread }));

  const renderWithSeed = <T,>(
    hook: () => T,
    seed: ReturnType<typeof seededList>,
  ) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seeded fresh (staleTime > 0), so useConversations serves it without an
    // immediate refetch — the hooks read this directly.
    queryClient.setQueryData(["conversations", undefined], seed);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return { queryClient, ...renderHook(hook, { wrapper }) };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname.value = "/chat";
    for (const key of Object.keys(wsHandlers)) delete wsHandlers[key];
    vi.mocked(archestraApiSdk.markChatConversationRead).mockResolvedValue({
      data: { success: true },
      error: undefined,
    } as Awaited<ReturnType<typeof archestraApiSdk.markChatConversationRead>>);
  });

  it("useMarkConversationRead optimistically clears unread in cached lists", async () => {
    const { queryClient, result } = renderWithSeed(
      () => useMarkConversationRead(),
      seededList({ id: "c1", unread: true }, { id: "c2", unread: true }),
    );

    act(() => {
      result.current.mutate({ id: "c1" });
    });

    const list = queryClient.getQueryData<
      Array<{ id: string; unread: boolean }>
    >(["conversations", undefined]);
    expect(list?.find((c) => c.id === "c1")?.unread).toBe(false);
    expect(list?.find((c) => c.id === "c2")?.unread).toBe(true);
    await waitFor(() =>
      expect(archestraApiSdk.markChatConversationRead).toHaveBeenCalledWith({
        path: { id: "c1" },
      }),
    );
  });

  it("useKeepViewedConversationRead marks the viewed unread conversation read", async () => {
    mockPathname.value = "/chat/c1";
    renderWithSeed(
      () => useKeepViewedConversationRead(),
      seededList({ id: "c1", unread: true }),
    );

    await waitFor(() =>
      expect(archestraApiSdk.markChatConversationRead).toHaveBeenCalledWith({
        path: { id: "c1" },
      }),
    );
  });

  it("useKeepViewedConversationRead does not mark an already-read viewed conversation", async () => {
    mockPathname.value = "/chat/c1";
    renderWithSeed(
      () => useKeepViewedConversationRead(),
      seededList({ id: "c1", unread: false }),
    );

    await Promise.resolve();
    expect(archestraApiSdk.markChatConversationRead).not.toHaveBeenCalled();
  });

  it("useKeepViewedConversationRead does not mark read off a conversation route", async () => {
    mockPathname.value = "/chat";
    renderWithSeed(
      () => useKeepViewedConversationRead(),
      seededList({ id: "c1", unread: true }),
    );

    await Promise.resolve();
    expect(archestraApiSdk.markChatConversationRead).not.toHaveBeenCalled();
  });

  it("useConversationUpdatedCacheSync invalidates conversations on a push", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useConversationUpdatedCacheSync(), { wrapper });

    expect(wsHandlers.conversation_updated).toBeDefined();
    act(() => {
      wsHandlers.conversation_updated({
        type: "conversation_updated",
        payload: { conversationId: "c1" },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["conversations"] });
  });
});
