/**
 * Typing-performance contract for the chat composer (GH #4256): a keystroke
 * updates the PromptInputProvider text state and rerenders PromptInputContent,
 * but the memoized footer toolbar (ChatPromptInputTools) must not rerender —
 * it hosts the model button, which is expensive with many models.
 *
 * Unlike prompt-input.test.tsx, this file keeps the real ai-elements
 * prompt-input module (provider, controller context, textarea) so a keystroke
 * exercises the real context-update path, and counts renders of the toolbar's
 * children to pin that the memo holds.
 */
import { E2eTestId } from "@archestra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderCounts, statusState, deploymentState, layoutState } = vi.hoisted(
  () => ({
    renderCounts: { modelButton: 0, apiKeySelector: 0 },
    statusState: {
      data: null as { trust: string; audience: string } | null,
      isError: false,
    },
    deploymentState: { active: true },
    layoutState: { isNarrow: false },
  }),
);

// Used by Radix and the toolbar-collapse hook; jsdom reports 0 widths, so the
// toolbar stays in its full (expanded) layout, which renders the selectors.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

// For the useIsMobile hook used by the real PromptInputTextarea
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Render-counting stubs for the toolbar's expensive children. If the toolbar
// memo breaks (an unstable prop at the call site, or a dropped memo), these
// rerender on every keystroke and the counts move.
vi.mock("@/components/chat/chat-model-button", () => ({
  ChatModelButton: () => {
    renderCounts.modelButton++;
    return <div data-testid="chat-model-button" />;
  },
}));

vi.mock("@/components/chat/llm-provider-api-key-selector", () => ({
  LlmProviderApiKeySelector: () => {
    renderCounts.apiKeySelector++;
    return <div data-testid="api-key-selector" />;
  },
}));

// The setup menu has its own behavior tests; here it only needs to show up.
vi.mock("@/components/chat/chat-setup-menu", () => ({
  ChatSetupMenu: () => <div data-testid="chat-setup-menu" />,
}));

vi.mock("@/lib/agent.query", () => ({
  useProfile: () => ({ data: null, isLoading: false, error: null }),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useConversation: () => ({ data: null }),
  useOpenappaStatus: () => statusState,
  useToggleHooksDebug: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/guardrails-deployment.query", () => ({
  useGuardrailsDeployment: () => ({ data: deploymentState }),
}));

vi.mock("@/lib/hooks/use-toolbar-collapse", () => ({
  useToolbarCollapse: () => layoutState.isNarrow,
}));

vi.mock("@/lib/chat/chat-placeholder.hook", () => ({
  useChatPlaceholder: () => ({
    placeholder: "placeholder",
    isAnimating: false,
  }),
}));

vi.mock("@/lib/skills/skill.query", () => ({
  useSkillsPaginated: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({ data: [] }),
}));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import ArchestraPromptInput from "./prompt-input";

describe("chat composer typing performance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFeature).mockImplementation((flag) =>
      flag === "openappaEnabled" ? true : undefined,
    );
    renderCounts.modelButton = 0;
    renderCounts.apiKeySelector = 0;
    statusState.data = null;
    statusState.isError = false;
    deploymentState.active = true;
    layoutState.isNarrow = false;
    localStorage.clear();
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
      isLoading: false,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
    // The full chat view, so the toolbar renders both provider selectors.
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: permissions.chat?.includes("full-view") === true,
          isPending: false,
          isLoading: false,
        }) as ReturnType<typeof useHasPermissions>,
    );
  });

  it("does not rerender the footer toolbar selectors on prompt keystrokes", () => {
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        onApiKeyChange={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId(E2eTestId.ChatPromptTextarea);
    expect(screen.getByTestId("chat-model-button")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-selector")).toBeInTheDocument();

    const modelButtonRendersAfterMount = renderCounts.modelButton;
    const apiKeySelectorRendersAfterMount = renderCounts.apiKeySelector;

    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "he" } });
    fireEvent.change(textarea, { target: { value: "hello" } });

    // The keystrokes really went through the provider round-trip: the
    // textarea is controlled by the provider-owned text state.
    expect(textarea).toHaveValue("hello");

    expect(renderCounts.modelButton).toBe(modelButtonRendersAfterMount);
    expect(renderCounts.apiKeySelector).toBe(apiKeySelectorRendersAfterMount);
  });

  it.each([
    "agent",
    "organization",
    "user",
  ] as const)("keeps new-chat controls inline when the model source is %s", (modelSource) => {
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        onApiKeyChange={vi.fn()}
        agentId="agent-1"
        modelSource={modelSource}
        currentProvider="anthropic"
      />,
    );
    expect(screen.getByTestId("chat-model-button")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-selector")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
  });

  it.each([
    "agent",
    "organization",
    "user",
  ] as const)("keeps an existing chat's controls inline when the model source is %s", (modelSource) => {
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        modelSource={modelSource}
        currentProvider="anthropic"
        conversationId="conv-1"
      />,
    );
    expect(screen.getByTestId("chat-model-button")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
  });

  it.each([
    ["a new chat", undefined],
    ["an existing chat", "conv-1"],
  ])("collapses controls for %s when they no longer fit", (_label, conversationId) => {
    layoutState.isNarrow = true;
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        onApiKeyChange={vi.fn()}
        agentId="agent-1"
        modelSource="agent"
        currentProvider="anthropic"
        conversationId={conversationId}
      />,
    );
    expect(screen.queryByTestId("chat-model-button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByTestId("chat-setup-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-model-button")).toBeNull();
  });

  it("puts context usage after the model picker while the pickers are inline", () => {
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
        tokensUsed={12_000}
        maxContextLength={200_000}
      />,
    );
    const modelButton = screen.getByTestId("chat-model-button");
    const contextUsage = screen.getByRole("button", { name: "Context usage" });
    expect(
      modelButton.compareDocumentPosition(contextUsage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps context usage in the toolbar once a chat moves its setup into More options", () => {
    layoutState.isNarrow = true;
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
        tokensUsed={12_000}
        maxContextLength={200_000}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Context usage" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More options" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat-setup-menu")).toBeNull();
  });

  it("names trust and audience on the session status and APPA", () => {
    statusState.data = { trust: "suspicious", audience: "internal" };
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
      />,
    );

    expect(
      screen.getByRole("status", {
        name: "Trust: suspicious; audience: internal",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Guardrails: trust suspicious, audience internal",
      }),
    ).toBeInTheDocument();
  });

  it("preserves policy-defined labels in the status text", () => {
    statusState.data = {
      trust: "reviewed",
      audience: "alice ∩ internal,@finance",
    };
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
      />,
    );

    expect(
      screen.getByRole("status", {
        name: "Trust: reviewed; audience: alice ∩ internal,@finance",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Guardrails: trust reviewed, audience alice ∩ internal,@finance",
      }),
    ).toBeInTheDocument();
  });

  it("hides retained labels when the selected session status read failed", () => {
    statusState.data = { trust: "trusted", audience: "public" };
    const { rerender } = render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
      />,
    );
    expect(
      screen.getByRole("status", { name: "Trust: trusted; audience: public" }),
    ).toBeInTheDocument();

    // The hook can expose retained data alongside an error for a session.
    statusState.isError = true;
    rerender(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4o"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-2"
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Status unavailable")).toBeNull();
  });

  it("hides the session tab before the status endpoint returns a label", () => {
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Status unavailable")).toBeNull();
  });

  it("hides the status when guardrails are disabled", () => {
    deploymentState.active = false;
    statusState.data = { trust: "trusted", audience: "public" };
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides the OpenAPPA icon when beta is disabled, even with stale active deployment data", () => {
    vi.mocked(useFeature).mockImplementation((flag) =>
      flag === "openappaEnabled" ? false : undefined,
    );
    statusState.data = { trust: "trusted", audience: "public" };
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps APPA above a narrow composer", () => {
    layoutState.isNarrow = true;
    statusState.data = { trust: "trusted", audience: "public" };
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
      />,
    );

    expect(
      screen.getByRole("status", { name: "Trust: trusted; audience: public" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Guardrails: trust trusted, audience public",
      }),
    ).toBeInTheDocument();
  });
  it("removes the session readout when navigating to a new chat", () => {
    statusState.data = { trust: "trusted", audience: "public" };
    const props = {
      onSubmit: vi.fn(),
      status: "ready" as const,
      selectedModel: "gpt-4",
      onModelChange: vi.fn(),
      agentId: "agent-1",
    };
    const { rerender } = render(
      <ArchestraPromptInput {...props} conversationId="conv-1" />,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(<ArchestraPromptInput {...props} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<ArchestraPromptInput {...props} conversationId="conv-2" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("does not show a chat trajectory for a runtime session", () => {
    render(
      <ArchestraPromptInput
        onSubmit={vi.fn()}
        status="ready"
        selectedModel="gpt-4"
        onModelChange={vi.fn()}
        agentId="agent-1"
        conversationId="conv-1"
        runtimeMode
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
