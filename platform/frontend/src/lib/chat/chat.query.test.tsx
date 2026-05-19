import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  mergeUpdatedConversationIntoCache,
  useConversations,
} from "./chat.query";

vi.mock("@shared", () => ({
  archestraApiSdk: {
    getChatConversations: vi.fn(),
  },
  PLAYWRIGHT_MCP_CATALOG_ID: "playwright-catalog-id",
  PLAYWRIGHT_MCP_SERVER_NAME: "playwright-mcp",
}));

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
        llmApiKeyId: "key-anthropic",
      },
      selectedModel: "claude-3-5-sonnet",
      selectedProvider: "anthropic",
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
    expect(merged.selectedModel).toBe("claude-3-5-sonnet");
    expect(merged.selectedProvider).toBe("anthropic");
    expect(merged.chatApiKeyId).toBe("key-anthropic");
  });

  test("keeps unrelated fields stable for a model-only update", () => {
    const oldConversation = makeConversation();
    const updatedConversation = {
      ...oldConversation,
      selectedModel: "gpt-4.1",
      selectedProvider: "openai",
    } satisfies archestraApiTypes.UpdateChatConversationResponses["200"];

    const merged = mergeUpdatedConversationIntoCache(
      oldConversation,
      updatedConversation,
      {
        id: "conversation-1",
        selectedModel: "gpt-4.1",
        selectedProvider: "openai",
      },
    );

    expect(merged.agentId).toBe("agent-a");
    expect(merged.chatApiKeyId).toBe("key-openai");
    expect(merged.selectedModel).toBe("gpt-4.1");
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
    hasCustomToolSelection: false,
    todoList: null,
    artifact: null,
    pinnedAt: null,
    createdAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
    agent: {
      id: "agent-a",
      name: "Agent A",
      systemPrompt: null,
      agentType: "agent",
      llmApiKeyId: "key-openai",
    },
    share: null,
    messages: [],
    chatErrors: [],
  };
}
