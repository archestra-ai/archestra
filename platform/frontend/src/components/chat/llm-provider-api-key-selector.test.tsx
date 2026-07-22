import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateConversation } from "@/lib/chat/chat.query";
import {
  type LlmProviderApiKey,
  useAvailableLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";
import { LlmProviderApiKeySelector } from "./llm-provider-api-key-selector";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/llm-provider-api-keys.query");
vi.mock("@/lib/chat/chat.query");

const AVAILABLE_KEYS = [
  {
    id: "key-anthropic",
    name: "Anthropic key",
    provider: "anthropic",
    scope: "personal",
    teamName: null,
  },
] as LlmProviderApiKey[];

describe("LlmProviderApiKeySelector auto-select", () => {
  const mutate = vi.fn();

  beforeEach(() => {
    mutate.mockClear();
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: AVAILABLE_KEYS,
      isLoading: false,
    } as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    vi.mocked(useUpdateConversation).mockReturnValue({
      mutate,
    } as unknown as ReturnType<typeof useUpdateConversation>);
  });

  it("auto-selects an available key when the conversation has none", () => {
    render(
      <LlmProviderApiKeySelector
        conversationId="conv-1"
        currentConversationChatApiKeyId={null}
        currentProvider="anthropic"
      />,
    );

    expect(mutate).toHaveBeenCalledWith({
      id: "conv-1",
      chatApiKeyId: "key-anthropic",
    });
  });

  it("holds the selection when the agent's default resolves per-user", () => {
    // The agent pins a subscription the viewer hasn't connected: switching the
    // conversation onto some other key would bypass the sign-in prompt on send.
    render(
      <LlmProviderApiKeySelector
        conversationId="conv-1"
        currentConversationChatApiKeyId={null}
        currentProvider="anthropic"
        suppressAutoSelect
      />,
    );

    expect(mutate).not.toHaveBeenCalled();
  });
});
