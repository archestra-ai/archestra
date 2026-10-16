import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSetupMenu, type ChatSetupMenuProps } from "./chat-setup-menu";

const { agents, models, keys, readiness, mutateConversation } = vi.hoisted(
  () => ({
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
        capabilities: { contextLength: 128_000, supportsReasoningEffort: true },
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
    ],
    readiness: [] as unknown[],
    mutateConversation: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("@/lib/agent.query", () => ({
  useChatAgents: () => ({ data: agents }),
  usePinnedAgentIds: () => ({ data: [] }),
  useProfile: () => ({ data: undefined }),
  useAgentCredentialReadiness: () => ({ data: readiness }),
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
    isHidden: () => false,
  }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
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

  it("offers reasoning depth only for models that support it", async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    const reasoning = screen.getByRole("radiogroup", {
      name: "Reasoning effort",
    });
    await user.click(within(reasoning).getByRole("radio", { name: /High/ }));
    expect(props.onThinkingEffortChange).toHaveBeenCalledWith("high");

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
    thinkingEffort: null,
    onThinkingEffortChange: vi.fn(),
    toolsUnavailable: false,
    notRecommendedForAgents: false,
    ...overrides,
  };
  render(<ChatSetupMenu {...props} />);
  return props;
}
