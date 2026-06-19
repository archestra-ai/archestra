import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import {
  mergeUpdatedConversationIntoCache,
  useConversation,
  useConversationEnabledTools,
  useConversationFiles,
  useConversations,
  useMemberDefaultModel,
} from "./chat.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getChatConversations: vi.fn(),
    getChatConversation: vi.fn(),
    getChatConversationFiles: vi.fn(),
    getMemberDefaultModel: vi.fn(),
    getConversationEnabledTools: vi.fn(),
  },
  PLAYWRIGHT_MCP_CATALOG_ID: "playwright-catalog-id",
  PLAYWRIGHT_MCP_SERVER_NAME: "playwright-mcp",
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
