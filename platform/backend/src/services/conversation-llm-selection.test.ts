import { vi } from "vitest";
import { ApiKeyModelModel, ChatApiKeyModel, OrganizationModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { resolveSmartDefaultLlmForChat } from "@/utils/llm-resolution";
import { resolveConversationLlmSelectionForAgent } from "./conversation-llm-selection";

vi.mock("@/utils/llm-resolution", async () => {
  const actual = await vi.importActual("@/utils/llm-resolution");
  return {
    ...actual,
    resolveSmartDefaultLlmForChat: vi.fn(),
  };
});

describe("resolveConversationLlmSelectionForAgent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(resolveSmartDefaultLlmForChat).mockResolvedValue({
      model: "claude-3-5-sonnet",
      provider: "anthropic",
    });
  });

  test("uses the agent model and key when both are configured", async () => {
    vi.spyOn(ChatApiKeyModel, "findById").mockResolvedValue({
      id: "key-openai",
      provider: "openai",
    } as never);

    const result = await resolveConversationLlmSelectionForAgent({
      agent: {
        llmApiKeyId: "key-openai",
        llmModel: "gpt-4o-mini",
      },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      chatApiKeyId: "key-openai",
      selectedModel: "gpt-4o-mini",
      selectedProvider: "openai",
    });
  });

  test("uses the best model for the agent key when only the key is configured", async () => {
    vi.spyOn(ChatApiKeyModel, "findById").mockResolvedValue({
      id: "key-anthropic",
      provider: "anthropic",
    } as never);
    vi.spyOn(ApiKeyModelModel, "getBestModel").mockResolvedValue({
      modelId: "claude-3-5-sonnet",
    } as never);

    const result = await resolveConversationLlmSelectionForAgent({
      agent: {
        llmApiKeyId: "key-anthropic",
        llmModel: null,
      },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      chatApiKeyId: "key-anthropic",
      selectedModel: "claude-3-5-sonnet",
      selectedProvider: "anthropic",
    });
  });

  test("falls back to the model provider when the agent key provider is unsupported", async () => {
    vi.spyOn(ChatApiKeyModel, "findById").mockResolvedValue({
      id: "key-unknown",
      provider: "not-a-provider",
    } as never);

    const result = await resolveConversationLlmSelectionForAgent({
      agent: {
        llmApiKeyId: "key-unknown",
        llmModel: "gpt-4o-mini",
      },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      chatApiKeyId: "key-unknown",
      selectedModel: "gpt-4o-mini",
      selectedProvider: "openai",
    });
  });

  test("falls back to the organization default when the agent has no override", async () => {
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      id: "org-1",
      defaultLlmModel: "gpt-4o",
      defaultLlmProvider: "openai",
      defaultLlmApiKeyId: "org-key",
    } as never);
    vi.spyOn(ChatApiKeyModel, "findById").mockResolvedValue({
      id: "org-key",
      provider: "openai",
    } as never);

    const result = await resolveConversationLlmSelectionForAgent({
      agent: {
        llmApiKeyId: null,
        llmModel: null,
      },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      chatApiKeyId: "org-key",
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
    });
  });

  test("falls back to the smart chat default when neither agent nor org is configured", async () => {
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      id: "org-1",
      defaultLlmModel: null,
      defaultLlmProvider: null,
      defaultLlmApiKeyId: null,
    } as never);

    const result = await resolveConversationLlmSelectionForAgent({
      agent: {
        llmApiKeyId: null,
        llmModel: null,
      },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      chatApiKeyId: null,
      selectedModel: "claude-3-5-sonnet",
      selectedProvider: "anthropic",
    });
  });
});
