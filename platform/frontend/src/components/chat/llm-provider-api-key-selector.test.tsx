import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmProviderApiKeySelector } from "./llm-provider-api-key-selector";

const { updateConversationMutateMock, useAvailableApiKeysMock } = vi.hoisted(
  () => ({
    updateConversationMutateMock: vi.fn(),
    useAvailableApiKeysMock: vi.fn(),
  }),
);

vi.mock("@/lib/chat/chat.query", () => ({
  useUpdateConversation: () => ({ mutate: updateConversationMutateMock }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: useAvailableApiKeysMock,
}));

const openaiKey = {
  id: "key-openai",
  name: "OpenAI Key",
  provider: "openai",
  scope: "personal",
  teamName: null,
};

const anthropicKey = {
  id: "key-anthropic",
  name: "Anthropic Key",
  provider: "anthropic",
  scope: "personal",
  teamName: null,
};

describe("LlmProviderApiKeySelector", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useAvailableApiKeysMock.mockReturnValue({
      data: [openaiKey, anthropicKey],
      isLoading: false,
    });
  });

  it("does not change a selected key when the current provider becomes unknown", () => {
    const { rerender } = render(
      <LlmProviderApiKeySelector
        conversationId="conv-1"
        currentConversationChatApiKeyId="key-openai"
        currentProvider="openai"
      />,
    );

    expect(updateConversationMutateMock).not.toHaveBeenCalled();

    rerender(
      <LlmProviderApiKeySelector
        conversationId="conv-1"
        currentConversationChatApiKeyId="key-openai"
        currentProvider={undefined}
      />,
    );

    expect(updateConversationMutateMock).not.toHaveBeenCalled();
  });

  it("auto-selects a provider-matching key when the selected key provider differs", async () => {
    render(
      <LlmProviderApiKeySelector
        conversationId="conv-1"
        currentConversationChatApiKeyId="key-openai"
        currentProvider="anthropic"
      />,
    );

    await waitFor(() => {
      expect(updateConversationMutateMock).toHaveBeenCalledWith({
        id: "conv-1",
        chatApiKeyId: "key-anthropic",
      });
    });
  });

  it("falls back to the first available key when no key is selected", async () => {
    render(
      <LlmProviderApiKeySelector
        conversationId="conv-1"
        currentConversationChatApiKeyId={null}
        currentProvider={undefined}
      />,
    );

    await waitFor(() => {
      expect(updateConversationMutateMock).toHaveBeenCalledWith({
        id: "conv-1",
        chatApiKeyId: "key-openai",
      });
    });
  });

  it("lets provider change own initial-chat key selection when available", async () => {
    const user = userEvent.setup();
    const onApiKeyChange = vi.fn();
    const onProviderChange = vi.fn();

    render(
      <LlmProviderApiKeySelector
        currentConversationChatApiKeyId="key-openai"
        currentProvider="openai"
        onApiKeyChange={onApiKeyChange}
        onProviderChange={onProviderChange}
      />,
    );

    await user.click(screen.getByTestId("chat-api-key-selector-trigger"));
    await user.click(screen.getByText("Anthropic Key"));

    expect(onApiKeyChange).not.toHaveBeenCalled();
    expect(onProviderChange).toHaveBeenCalledWith("anthropic", "key-anthropic");
  });

  it("keeps the key trigger mounted while model selection is resolving", () => {
    render(
      <LlmProviderApiKeySelector
        conversationId="conv-1"
        currentConversationChatApiKeyId="key-openai"
        currentProvider="openai"
        isModelsLoading
      />,
    );

    const trigger = screen.getByTestId("chat-api-key-selector-trigger");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toBeDisabled();
    expect(trigger.querySelector(".animate-spin")).not.toBeInTheDocument();
  });

  it("shows a loader when API keys are loading", () => {
    useAvailableApiKeysMock.mockReturnValue({
      data: [],
      isLoading: true,
    });

    render(
      <LlmProviderApiKeySelector
        conversationId="conv-1"
        currentConversationChatApiKeyId="key-openai"
        currentProvider="openai"
      />,
    );

    const trigger = screen.getByTestId("chat-api-key-selector-trigger");
    expect(trigger).toBeDisabled();
    expect(trigger.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("does not render when no keys are available and nothing is loading", () => {
    useAvailableApiKeysMock.mockReturnValue({
      data: [],
      isLoading: false,
    });

    render(
      <LlmProviderApiKeySelector
        conversationId="conv-1"
        currentConversationChatApiKeyId={null}
        currentProvider={undefined}
      />,
    );

    expect(
      screen.queryByTestId("chat-api-key-selector-trigger"),
    ).not.toBeInTheDocument();
  });
});
