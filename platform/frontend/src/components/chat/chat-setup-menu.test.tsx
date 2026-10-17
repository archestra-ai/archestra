import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { ChatSetupMenu, type ChatSetupMenuProps } from "./chat-setup-menu";

const {
  agents,
  models,
  keys,
  readiness,
  mutateConversation,
  hiddenProviders,
  navigate,
} = vi.hoisted(() => ({
  agents: [
    {
      id: "agent-mine",
      name: "My Assistant",
      description: null,
      icon: null,
      scope: "personal",
      authorId: "user-1",
      builtIn: false,
      runtime: null,
    },
    {
      id: "agent-research",
      name: "Research",
      description: null,
      icon: null,
      scope: "org",
      authorId: "someone-else",
      builtIn: false,
      runtime: null,
    },
  ],
  models: [
    {
      dbId: "model-thinker",
      id: "qwen3-32b",
      provider: "vllm",
      displayName: "Qwen3 32B",
      isBest: true,
      isFree: false,
      requiresUserConnection: false,
      isConnected: true,
      capabilities: {
        contextLength: 128_000,
        supportsReasoningEffort: true,
        supportsToolCalling: true,
        inputModalities: ["text", "image"],
        pricePerMillionInput: "3",
        pricePerMillionOutput: "15",
      },
    },
    {
      dbId: "model-plain",
      id: "llama-3-8b",
      provider: "vllm",
      displayName: "Llama 3 8B",
      isBest: false,
      isFree: false,
      requiresUserConnection: false,
      isConnected: true,
      capabilities: { contextLength: 8_000, supportsReasoningEffort: false },
    },
  ],
  hiddenProviders: new Set<string>(),
  keys: [
    {
      id: "key-org",
      name: "Org vLLM",
      provider: "vllm",
      scope: "org",
      userId: null,
      teamName: null,
    },
    {
      id: "key-team",
      name: "Team vLLM",
      provider: "vllm",
      scope: "team",
      userId: null,
      teamName: "Platform",
    },
  ] as unknown as LlmProviderApiKey[],
  readiness: [] as unknown[],
  mutateConversation: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigate }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("@/lib/agent.query", () => ({
  useChatAgents: () => ({ data: agents }),
  useChatAgentPages: () => ({
    data: undefined,
    hasNextPage: false,
    isFetching: false,
    isError: false,
    fetchNextPage: vi.fn(),
  }),
  useChatAgentReferences: () => ({ data: [] }),
  usePinnedAgentIds: () => ({ data: [] }),
  useProfile: () => ({ data: undefined }),
  useAgentCredentialReadinessPages: () => ({ data: readiness }),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({
    data: models,
    isLoading: false,
    isPlaceholderData: false,
  }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({ data: keys }),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useUpdateConversation: () => ({ mutate: mutateConversation }),
}));

vi.mock("@/lib/integration-overrides", () => ({
  useModelProviderCatalog: () => ({
    label: (provider: string) => (provider === "vllm" ? "vLLM" : provider),
    isHidden: (provider: string) => hiddenProviders.has(provider),
  }),
}));

const originalKeys = [...keys];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  keys.splice(0, keys.length, ...originalKeys);
  hiddenProviders.clear();
  navigate.mockClear();
  readiness.splice(0);
  mutateConversation.mockReset();
});

describe("ChatSetupMenu", () => {
  it("shows the current setup as tabs and applies a model choice", async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    const tabs = screen.getByRole("tablist");
    expect(
      within(tabs).getByRole("tab", { name: "Model: Qwen3 32B" }),
    ).toHaveAttribute("aria-selected", "true");
    within(tabs).getByRole("tab", { name: "Agent: My Assistant" });
    within(tabs).getByRole("tab", { name: /^Key: Org vLLM/ });

    const thinker = screen.getByRole("option", { name: /Qwen3 32B/ });
    expect(thinker).toHaveTextContent("128K context·$3 / $15");
    expect(
      within(thinker).getByRole("img", { name: "Current" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("option", { name: /Llama 3 8B/ })).queryByRole(
        "img",
        { name: "Current" },
      ),
    ).not.toBeInTheDocument();
    for (const capability of [
      "Reads images",
      "Uses tools",
      "Adjustable reasoning",
    ]) {
      within(thinker).getByRole("img", { name: capability });
    }

    await user.click(screen.getByRole("option", { name: /Llama 3 8B/ }));

    expect(props.onModelChange).toHaveBeenCalledWith("model-plain");
    expect(props.close).toHaveBeenCalled();
  });

  it("switches a conversation's key in one update and stays open", async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    await user.click(screen.getByRole("tab", { name: /^Key:/ }));
    await user.click(screen.getByRole("option", { name: /Team vLLM/ }));

    expect(props.onProviderChange).toHaveBeenCalledWith("vllm", "key-team");
    expect(mutateConversation).not.toHaveBeenCalled();
    expect(props.close).not.toHaveBeenCalled();
    // Back on the model tab: the new key decides which models exist.
    expect(
      screen.getByRole("tab", { name: "Model: Qwen3 32B" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("offers subscription connections even without an API key and supports keyboard selection", async () => {
    keys.splice(0);
    const user = userEvent.setup();
    const props = renderMenu();
    await user.click(screen.getByRole("tab", { name: "Key: Default key" }));
    expect(screen.getByText("Personal subscriptions")).toBeInTheDocument();
    const search = screen.getByRole("combobox", { name: "Chat options" });
    await user.type(search, "ChatGPT");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(props.onSubscriptionSelect).toHaveBeenCalledWith(
      "connect-subscription-chatgpt",
    );
    expect(props.close).toHaveBeenCalledOnce();
    expect(props.onProviderChange).not.toHaveBeenCalled();
  });

  it("keeps subscriptions separate from keys, private to their owner, and does not hide a second connection", async () => {
    const user = userEvent.setup();
    keys.push(
      ...[
        { id: "my-sub", name: "My ChatGPT", userId: "user-1" },
        { id: "my-second-sub", name: "Second ChatGPT", userId: "user-1" },
        {
          id: "other-sub",
          name: "Another person's subscription",
          userId: "user-2",
        },
      ].map(
        (key) =>
          ({
            ...key,
            provider: "openai",
            scope: "personal",
            subscriptionKind: "chatgpt",
          }) as LlmProviderApiKey,
      ),
    );
    const props = renderMenu();
    await user.click(screen.getByRole("tab", { name: /^Key:/ }));
    const group = screen.getByRole("group", { name: "Personal subscriptions" });
    expect(within(group).getAllByRole("option")).toHaveLength(5);
    expect(
      screen.queryByText("Another person's subscription"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("ChatGPT Subscription")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: /My ChatGPT/ })).toHaveLength(
      1,
    );
    await user.click(screen.getByRole("option", { name: /Second ChatGPT/ }));
    expect(props.onProviderChange).toHaveBeenCalledWith(
      "openai",
      "my-second-sub",
    );
    expect(props.onSubscriptionSelect).not.toHaveBeenCalled();
    expect(props.close).not.toHaveBeenCalled();
  });

  it("opens reconnect for an expired subscription without switching the conversation to it", async () => {
    keys.push({
      id: "expired-sub",
      name: "My ChatGPT",
      provider: "openai",
      scope: "personal",
      userId: "user-1",
      subscriptionKind: "chatgpt",
      requiresReauthentication: true,
    } as LlmProviderApiKey);
    const user = userEvent.setup();
    const props = renderMenu();
    await user.click(screen.getByRole("tab", { name: /^Key:/ }));
    const expired = screen.getByRole("option", { name: /My ChatGPT/ });
    expect(expired).toHaveTextContent("Reconnect");
    await user.click(expired);
    expect(props.onSubscriptionSelect).toHaveBeenCalledWith("expired-sub");
    expect(props.onProviderChange).not.toHaveBeenCalled();
    expect(props.close).toHaveBeenCalledOnce();
  });

  it("omits connections for disabled providers and keeps manage keys available during a search", async () => {
    hiddenProviders.add("openai");
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("tab", { name: /^Key:/ }));
    expect(screen.queryByText("ChatGPT Subscription")).not.toBeInTheDocument();
    await user.type(
      screen.getByRole("combobox", { name: "Chat options" }),
      "no match",
    );
    expect(
      screen.getByRole("button", { name: "Manage provider keys" }),
    ).toBeInTheDocument();
  });

  it("lets the footer keep its own Enter key without selecting the highlighted credential", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await user.click(screen.getByRole("tab", { name: /^Key:/ }));
    screen.getByRole("button", { name: "Manage provider keys" }).focus();
    await user.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith("/llm/model-providers");
    expect(props.onSubscriptionSelect).not.toHaveBeenCalled();
    expect(props.onProviderChange).not.toHaveBeenCalled();
    expect(props.close).toHaveBeenCalledOnce();
  });

  it("does not let the user pick an agent blocked by a missing connection", async () => {
    readiness.push({
      agentId: "agent-research",
      missingCredentialBehavior: "block",
      missingConnections: [{ catalogId: "github", catalogName: "GitHub" }],
    });
    const user = userEvent.setup();
    const props = renderMenu();

    await user.click(screen.getByRole("tab", { name: /^Agent:/ }));
    const blocked = screen.getByRole("option", { name: /Research/ });

    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveTextContent("Needs GitHub");
    await user.click(blocked);
    expect(props.onAgentChange).not.toHaveBeenCalled();
  });

  it("marks reasoning only where the reasoning control is offered", () => {
    // The catalog says Opus 4.8 reasons, but the composer offers no depth for
    // it (thinking stays off by default), so the row must not promise one.
    models.push({
      dbId: "model-opus",
      id: "claude-opus-4-8",
      provider: "anthropic",
      displayName: "Claude Opus 4.8",
      isBest: false,
      isFree: false,
      requiresUserConnection: false,
      isConnected: true,
      capabilities: { contextLength: 1_000_000, supportsReasoningEffort: true },
    });
    try {
      renderMenu();
      const opus = screen.getByRole("option", { name: /Claude Opus 4\.8/ });
      expect(
        within(opus).queryByRole("img", { name: "Adjustable reasoning" }),
      ).not.toBeInTheDocument();
    } finally {
      models.pop();
    }
  });

  it("offers reasoning depth only for models that support it", async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    const reasoning = screen.getByRole("radiogroup", {
      name: "Reasoning effort",
    });
    // One chip: a click steps from Auto to the next level.
    await user.click(
      within(reasoning).getByRole("radio", { name: "Reasoning: Auto" }),
    );
    expect(props.onThinkingEffortChange).toHaveBeenCalledWith("low");

    renderMenu({ selectedModel: "model-plain" });
    expect(
      screen.getAllByRole("radiogroup", { name: "Reasoning effort" }),
    ).toHaveLength(1);
  });
});

function renderMenu(overrides: Partial<ChatSetupMenuProps> = {}) {
  const props: ChatSetupMenuProps = {
    conversationId: "conversation-1",
    close: vi.fn(),
    agentId: "agent-mine",
    onAgentChange: vi.fn(),
    canShowProviderSettings: true,
    selectedModel: "model-thinker",
    onModelChange: vi.fn(),
    suppressAutoSelect: false,
    apiKeyId: "key-org",
    currentProvider: "vllm",
    canChangeCredential: true,
    onProviderChange: vi.fn(),
    subscriptionConnectRequired: false,
    subscriptionSignInTitle: "Sign in",
    onSubscriptionSelect: vi.fn(),
    thinkingEffort: null,
    onThinkingEffortChange: vi.fn(),
    toolsUnavailable: false,
    notRecommendedForAgents: false,
    ...overrides,
  };
  render(<ChatSetupMenu {...props} />);
  return props;
}
