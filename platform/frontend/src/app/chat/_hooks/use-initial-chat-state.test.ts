import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { CHAT_STORAGE_KEYS } from "@/lib/chat/use-chat-preferences";
import { useInitialChatState } from "./use-initial-chat-state";

describe("useInitialChatState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("chooses the URL agent once and does not reapply it after manual change", () => {
    const params = makeParams({
      searchParams: makeSearchParams({ agentId: "agent-b" }),
    });
    const { result, rerender } = renderHook(
      (props: typeof params) => useInitialChatState(props),
      { initialProps: params },
    );

    expect(result.current.initialAgentId).toBe("agent-b");

    act(() => result.current.handleInitialAgentChange("agent-a"));
    expect(result.current.initialAgentId).toBe("agent-a");

    rerender(params);
    expect(result.current.initialAgentId).toBe("agent-a");
  });

  test("organization default agent and model beat saved local preference", () => {
    localStorage.setItem(CHAT_STORAGE_KEYS.selectedAgent, "agent-b");

    const { result } = renderHook(() =>
      useInitialChatState(
        makeParams({
          organization: {
            defaultAgentId: "agent-a",
            defaultLlmModel: "gpt-4.1",
            defaultLlmApiKeyId: "key-openai",
          },
        }),
      ),
    );

    expect(result.current.initialAgentId).toBe("agent-a");
    expect(result.current.initialModel).toBe("gpt-4.1");
    expect(result.current.initialApiKeyId).toBe("key-openai");
    expect(result.current.initialModelSource).toBe("organization");
  });

  test("agent-configured model beats organization default model", () => {
    const { result } = renderHook(() =>
      useInitialChatState(
        makeParams({
          internalAgents: [
            {
              id: "agent-a",
              llmModel: "claude-3-5-sonnet",
              llmApiKeyId: "key-anthropic",
            },
          ],
          organization: {
            defaultAgentId: "agent-a",
            defaultLlmModel: "gpt-4.1",
            defaultLlmApiKeyId: "key-openai",
          },
        }),
      ),
    );

    expect(result.current.initialModel).toBe("claude-3-5-sonnet");
    expect(result.current.initialApiKeyId).toBe("key-anthropic");
    expect(result.current.initialModelSource).toBe("agent");
  });

  test("provider change selects the provider's best model as a user override", () => {
    const { result } = renderHook(() => useInitialChatState(makeParams()));

    act(() => {
      result.current.handleInitialProviderChange("anthropic", "key-anthropic");
    });

    expect(result.current.initialModel).toBe("claude-3-5-sonnet");
    expect(result.current.initialModelSource).toBe("user");
    expect(localStorage.getItem(CHAT_STORAGE_KEYS.userModelOverride)).toBe(
      "claude-3-5-sonnet",
    );
  });

  test("reset model override restores the agent or organization default", () => {
    const { result } = renderHook(() =>
      useInitialChatState(
        makeParams({
          internalAgents: [
            {
              id: "agent-a",
              llmModel: "claude-3-5-sonnet",
              llmApiKeyId: "key-anthropic",
            },
          ],
        }),
      ),
    );

    act(() => {
      result.current.handleInitialModelSelectorOpenChange(true);
      result.current.handleInitialModelChange("gpt-4.1");
    });
    expect(result.current.initialModel).toBe("gpt-4.1");

    act(() => result.current.handleResetModelOverride());
    expect(result.current.initialModel).toBe("claude-3-5-sonnet");
    expect(result.current.initialModelSource).toBe("agent");
    expect(
      localStorage.getItem(CHAT_STORAGE_KEYS.userModelOverride),
    ).toBeNull();
  });
});

function makeSearchParams(values: Record<string, string> = {}) {
  return {
    get(name: string) {
      return values[name] ?? null;
    },
  };
}

function makeParams(
  overrides: Partial<Parameters<typeof useInitialChatState>[0]> = {},
): Parameters<typeof useInitialChatState>[0] {
  return {
    internalAgents: [{ id: "agent-a" }, { id: "agent-b" }],
    defaultAgentId: undefined,
    searchParams: makeSearchParams(),
    chatApiKeys: [
      { id: "key-openai", provider: "openai", bestModelId: "gpt-4.1" },
      {
        id: "key-anthropic",
        provider: "anthropic",
        bestModelId: "claude-3-5-sonnet",
      },
    ],
    organization: null,
    isOrgLoading: false,
    ...overrides,
  };
}
