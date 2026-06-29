import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmModel } from "@/lib/llm-models.query";
import type { SupportedProvider } from "@/lib/llm-provider-api-keys.query";
import { CHAT_STORAGE_KEYS } from "./use-chat-preferences";
import { useInitialChatModelState } from "./use-initial-chat-model-state.hook";

const mutate = vi.fn();
vi.mock("./chat.query", () => ({
  useUpdateMemberDefaultModel: () => ({ mutate }),
}));

const model = (dbId: string, provider: string, isBest = false) =>
  ({ id: dbId, dbId, provider, isBest }) as unknown as LlmModel;

type Agent = {
  id: string;
  modelId?: string | null;
  llmApiKeyId?: string | null;
};

const agents: Agent[] = [
  { id: "agent-1", modelId: "uuid-gpt", llmApiKeyId: "key-openai" },
  { id: "agent-2", modelId: null, llmApiKeyId: null },
];

const modelsByProvider: Record<string, LlmModel[]> = {
  openai: [model("uuid-gpt", "openai", true), model("uuid-gpt-mini", "openai")],
  anthropic: [model("uuid-claude", "anthropic", true)],
};

const chatApiKeys = [
  { id: "key-openai", provider: "openai" },
  { id: "key-anthropic", provider: "anthropic" },
];

const baseParams = {
  agents,
  organization: null,
  defaultAgentId: null as string | null,
  modelsByProvider,
  chatApiKeys,
  memberDefault: null,
  canUseSavedAgent: true,
  isPermissionResolving: false,
  isOrgLoading: false,
};

beforeEach(() => {
  mutate.mockClear();
  localStorage.clear();
});

describe("useInitialChatModelState", () => {
  it("resolves the first agent and its model/key when nothing else is set", async () => {
    const { result } = renderHook(() => useInitialChatModelState(baseParams));

    await waitFor(() => expect(result.current.agentId).toBe("agent-1"));
    expect(result.current.modelId).toBe("uuid-gpt");
    expect(result.current.apiKeyId).toBe("key-openai");
  });

  it("honors the org default agent over the first agent", async () => {
    const { result } = renderHook(() =>
      useInitialChatModelState({
        ...baseParams,
        organization: { defaultAgentId: "agent-2" },
      }),
    );

    await waitFor(() => expect(result.current.agentId).toBe("agent-2"));
  });

  it("uses the saved agent when canUseSavedAgent is true", async () => {
    localStorage.setItem(CHAT_STORAGE_KEYS.selectedAgent, "agent-2");

    const { result } = renderHook(() => useInitialChatModelState(baseParams));

    await waitFor(() => expect(result.current.agentId).toBe("agent-2"));
  });

  it("skips a saved-but-not-permitted agent when canUseSavedAgent is false", async () => {
    localStorage.setItem(CHAT_STORAGE_KEYS.selectedAgent, "agent-2");

    const { result } = renderHook(() =>
      useInitialChatModelState({ ...baseParams, canUseSavedAgent: false }),
    );

    // Falls through to the first available agent instead of the saved one.
    await waitFor(() => expect(result.current.agentId).toBe("agent-1"));
  });

  it("holds resolution while permissions are resolving", async () => {
    const { result, rerender } = renderHook(
      (props: typeof baseParams) => useInitialChatModelState(props),
      { initialProps: { ...baseParams, isPermissionResolving: true } },
    );

    // Give effects a chance to run; nothing should resolve yet.
    await Promise.resolve();
    expect(result.current.agentId).toBeNull();

    rerender({ ...baseParams, isPermissionResolving: false });
    await waitFor(() => expect(result.current.agentId).toBe("agent-1"));
  });

  it("holds resolution while the organization data is loading", async () => {
    const { result, rerender } = renderHook(
      (props: typeof baseParams) => useInitialChatModelState(props),
      { initialProps: { ...baseParams, isOrgLoading: true } },
    );

    await Promise.resolve();
    expect(result.current.agentId).toBeNull();

    rerender({ ...baseParams, isOrgLoading: false });
    await waitFor(() => expect(result.current.agentId).toBe("agent-1"));
  });

  it("resolves the URL agent when supplied, regardless of the saved agent", async () => {
    localStorage.setItem(CHAT_STORAGE_KEYS.selectedAgent, "agent-1");

    const { result } = renderHook(() =>
      useInitialChatModelState({ ...baseParams, urlAgentId: "agent-2" }),
    );

    await waitFor(() => expect(result.current.agentId).toBe("agent-2"));
  });

  it("derives the provider and persists the member default on a model change", async () => {
    const { result } = renderHook(() => useInitialChatModelState(baseParams));

    await waitFor(() => expect(result.current.agentId).toBe("agent-1"));
    expect(result.current.provider).toBe("openai");

    act(() => result.current.onModelChange("uuid-gpt-mini"));

    expect(result.current.modelId).toBe("uuid-gpt-mini");
    expect(mutate).toHaveBeenCalledWith({
      modelId: "uuid-gpt-mini",
      chatApiKeyId: "key-openai",
    });
  });

  it("preserves the api-key two-step: key set first, then provider re-resolves the model", async () => {
    const { result } = renderHook(() => useInitialChatModelState(baseParams));

    await waitFor(() => expect(result.current.apiKeyId).toBe("key-openai"));

    // Same shape as the api-key selector: setApiKeyId then onProviderChange.
    act(() => {
      result.current.setApiKeyId("key-anthropic");
      result.current.onProviderChange(
        "anthropic" as SupportedProvider,
        "key-anthropic",
      );
    });

    expect(result.current.apiKeyId).toBe("key-anthropic");
    // The best model for the new provider is selected.
    expect(result.current.modelId).toBe("uuid-claude");
    expect(mutate).toHaveBeenCalledWith({
      modelId: "uuid-claude",
      chatApiKeyId: "key-anthropic",
    });
  });

  it("selecting a key for the same provider keeps that provider's best model", async () => {
    const { result } = renderHook(() => useInitialChatModelState(baseParams));

    await waitFor(() => expect(result.current.apiKeyId).toBe("key-openai"));

    act(() => {
      result.current.setApiKeyId("key-openai");
      result.current.onProviderChange(
        "openai" as SupportedProvider,
        "key-openai",
      );
    });

    expect(result.current.apiKeyId).toBe("key-openai");
    expect(result.current.modelId).toBe("uuid-gpt");
  });

  it("writes the saved-agent key on auto-select and on a manual change", async () => {
    const { result } = renderHook(() => useInitialChatModelState(baseParams));

    await waitFor(() => expect(result.current.agentId).toBe("agent-1"));
    // Auto-selection writes the saved agent.
    expect(localStorage.getItem(CHAT_STORAGE_KEYS.selectedAgent)).toBe(
      "agent-1",
    );

    act(() => result.current.onAgentChange("agent-2"));

    expect(result.current.agentId).toBe("agent-2");
    expect(localStorage.getItem(CHAT_STORAGE_KEYS.selectedAgent)).toBe(
      "agent-2",
    );
  });

  // agent-2 carries an explicit anthropic model/key so the reset's re-resolution
  // is observable across all three fields (agent-2's null defaults would
  // otherwise resolve to the same model/key as agent-1).
  const resetAgents: Agent[] = [
    { id: "agent-1", modelId: "uuid-gpt", llmApiKeyId: "key-openai" },
    { id: "agent-2", modelId: "uuid-claude", llmApiKeyId: "key-anthropic" },
  ];
  type ResetProps = Omit<typeof baseParams, "organization"> & {
    organization: { defaultAgentId?: string | null } | null;
    routeConversationId?: string;
  };

  it("resets the resolved selection when leaving a conversation for the initial chat route", async () => {
    const { result, rerender } = renderHook(
      (props: ResetProps) => useInitialChatModelState(props),
      {
        initialProps: {
          ...baseParams,
          agents: resetAgents,
          routeConversationId: "conv-1",
        } as ResetProps,
      },
    );

    await waitFor(() => expect(result.current.agentId).toBe("agent-1"));
    expect(result.current.modelId).toBe("uuid-gpt");
    expect(result.current.apiKeyId).toBe("key-openai");

    // defined -> undefined: leaving a conversation for the new-chat route resets
    // the resolved agent/model/key (agentId -> null, modelId -> "", apiKeyId ->
    // null), so the next new chat re-resolves from scratch instead of inheriting
    // the prior selection. The reset clears agentId, which lets the agent-
    // resolution effect re-run and pick up the now-current org default; without
    // the reset the stale agentId would block re-resolution and keep agent-1.
    rerender({
      ...baseParams,
      agents: resetAgents,
      organization: { defaultAgentId: "agent-2" },
      routeConversationId: undefined,
    } as ResetProps);

    await waitFor(() => expect(result.current.agentId).toBe("agent-2"));
    expect(result.current.modelId).toBe("uuid-claude");
    expect(result.current.apiKeyId).toBe("key-anthropic");
  });

  it("does not reset on a rerender while the conversation route stays defined", async () => {
    const { result, rerender } = renderHook(
      (props: ResetProps) => useInitialChatModelState(props),
      {
        initialProps: {
          ...baseParams,
          agents: resetAgents,
          routeConversationId: "conv-1",
        } as ResetProps,
      },
    );

    await waitFor(() => expect(result.current.agentId).toBe("agent-1"));

    // Same conversation id on rerender (and an unrelated org-default change):
    // the route did not go defined -> undefined, so the resolved selection is
    // preserved and the new org default is NOT applied.
    rerender({
      ...baseParams,
      agents: resetAgents,
      organization: { defaultAgentId: "agent-2" },
      routeConversationId: "conv-1",
    } as ResetProps);

    expect(result.current.agentId).toBe("agent-1");
    expect(result.current.modelId).toBe("uuid-gpt");
    expect(result.current.apiKeyId).toBe("key-openai");
  });

  it("reset clears the member default and re-resolves without the override", async () => {
    const { result } = renderHook(() =>
      useInitialChatModelState({
        ...baseParams,
        memberDefault: {
          modelId: "uuid-claude",
          chatApiKeyId: "key-anthropic",
        },
      }),
    );

    await waitFor(() => expect(result.current.agentId).toBe("agent-1"));

    act(() => result.current.onResetModelOverride());

    expect(mutate).toHaveBeenCalledWith({
      modelId: null,
      chatApiKeyId: null,
    });
    // Reset drops the member override and falls back to the agent's model.
    expect(result.current.modelId).toBe("uuid-gpt");
  });
});
