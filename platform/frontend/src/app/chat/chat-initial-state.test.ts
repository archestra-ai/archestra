import { describe, expect, test } from "vitest";
import {
  buildCreateConversationInput,
  isAutoSendHandoffInProgress,
  resolveChatModelState,
  resolveInitialAgentSelection,
  resolveInitialAgentState,
  resolvePreferredModelForProvider,
  shouldResetInitialChatState,
} from "./chat-initial-state";

// Mock LlmModel: `id` is the provider model string, `dbId` the models.id UUID.
const model = (id: string, dbId: string, provider: string, isBest = false) =>
  ({ id, dbId, provider, isBest }) as never;

describe("resolveInitialAgentState", () => {
  test("returns org default model for an agent without its own model", () => {
    const result = resolveInitialAgentState({
      agent: { id: "agent-1" },
      modelsByProvider: {
        openai: [model("gpt-4.1", "uuid-gpt", "openai")],
      },
      chatApiKeys: [{ id: "key-1", provider: "openai" }],
      organization: {
        defaultModelId: "uuid-gpt",
        defaultLlmApiKeyId: "key-1",
      },
      memberDefault: null,
    });

    expect(result).toEqual({
      agentId: "agent-1",
      modelId: "uuid-gpt",
      apiKeyId: "key-1",
    });
  });

  test("returns agent-configured model when available", () => {
    const result = resolveInitialAgentState({
      agent: {
        id: "agent-1",
        modelId: "uuid-sonnet",
        llmApiKeyId: "key-2",
      },
      modelsByProvider: {
        anthropic: [model("claude-3-5-sonnet", "uuid-sonnet", "anthropic")],
      },
      chatApiKeys: [{ id: "key-2", provider: "anthropic" }],
      organization: {
        defaultModelId: "uuid-gpt",
        defaultLlmApiKeyId: "key-1",
      },
      memberDefault: null,
    });

    expect(result).toEqual({
      agentId: "agent-1",
      modelId: "uuid-sonnet",
      apiKeyId: "key-2",
    });
  });

  test("prefers the member default over the agent-configured model", () => {
    const result = resolveInitialAgentState({
      agent: {
        id: "agent-1",
        modelId: "uuid-sonnet",
        llmApiKeyId: "key-2",
      },
      modelsByProvider: {
        anthropic: [model("claude-3-5-sonnet", "uuid-sonnet", "anthropic")],
        openai: [model("gpt-4.1", "uuid-gpt", "openai")],
      },
      chatApiKeys: [
        { id: "key-1", provider: "openai" },
        { id: "key-2", provider: "anthropic" },
      ],
      organization: null,
      memberDefault: { modelId: "uuid-gpt", chatApiKeyId: "key-1" },
    });

    expect(result).toEqual({
      agentId: "agent-1",
      modelId: "uuid-gpt",
      apiKeyId: "key-1",
    });
  });
});

describe("resolveInitialAgentSelection", () => {
  const agents = [
    { id: "first-agent" },
    { id: "member-default" },
    { id: "saved-agent" },
    { id: "org-default" },
  ];

  test("prefers the organization default over saved and member defaults", () => {
    expect(
      resolveInitialAgentSelection({
        agents,
        organizationDefaultAgentId: "org-default",
        savedAgentId: "saved-agent",
        memberDefaultAgentId: "member-default",
        canUseSavedAgent: true,
      })?.id,
    ).toBe("org-default");
  });

  test("uses saved agent before member default when the picker is available", () => {
    expect(
      resolveInitialAgentSelection({
        agents,
        organizationDefaultAgentId: null,
        savedAgentId: "saved-agent",
        memberDefaultAgentId: "member-default",
        canUseSavedAgent: true,
      })?.id,
    ).toBe("saved-agent");
  });

  test("ignores saved agent when the picker is hidden", () => {
    expect(
      resolveInitialAgentSelection({
        agents,
        organizationDefaultAgentId: null,
        savedAgentId: "saved-agent",
        memberDefaultAgentId: "member-default",
        canUseSavedAgent: false,
      })?.id,
    ).toBe("member-default");
  });

  test("returns null when no agents are available", () => {
    expect(
      resolveInitialAgentSelection({
        agents: [],
        organizationDefaultAgentId: "org-default",
        savedAgentId: "saved-agent",
        memberDefaultAgentId: "member-default",
        canUseSavedAgent: true,
      }),
    ).toBeNull();
  });

  test("falls back to the first agent when no defaults match", () => {
    expect(
      resolveInitialAgentSelection({
        agents,
        organizationDefaultAgentId: null,
        savedAgentId: "missing-saved-agent",
        memberDefaultAgentId: "missing-member-default",
        canUseSavedAgent: true,
      })?.id,
    ).toBe("first-agent");
  });
});

describe("resolveChatModelState", () => {
  test("resolves the agent's model and api key", () => {
    const result = resolveChatModelState({
      agent: { id: "agent-1", modelId: "uuid-gpt", llmApiKeyId: "key-1" },
      modelsByProvider: {
        openai: [model("gpt-4.1", "uuid-gpt", "openai")],
      },
      chatApiKeys: [{ id: "key-1", provider: "openai" }],
      organization: null,
      memberDefault: null,
    });

    expect(result).toEqual({
      modelId: "uuid-gpt",
      apiKeyId: "key-1",
    });
  });
});

describe("resolvePreferredModelForProvider", () => {
  test("prefers the best model for a provider", () => {
    expect(
      resolvePreferredModelForProvider({
        provider: "openai",
        modelsByProvider: {
          openai: [
            model("gpt-4.1-mini", "uuid-mini", "openai"),
            model("gpt-4.1", "uuid-gpt", "openai", true),
          ],
        },
      }),
    ).toEqual({
      modelId: "uuid-gpt",
      provider: "openai",
    });
  });

  test("returns null when the provider has no models", () => {
    expect(
      resolvePreferredModelForProvider({
        provider: "openai",
        modelsByProvider: {},
      }),
    ).toBeNull();
  });
});

describe("buildCreateConversationInput", () => {
  test("builds the payload from the selected initial chat state", () => {
    expect(
      buildCreateConversationInput({
        agentId: "agent-1",
        modelId: "uuid-gpt",
        chatApiKeyId: "key-1",
      }),
    ).toEqual({
      agentId: "agent-1",
      modelId: "uuid-gpt",
      chatApiKeyId: "key-1",
    });
  });

  test("builds a minimal payload when model selectors are unavailable", () => {
    expect(
      buildCreateConversationInput({
        agentId: "agent-1",
        modelId: "",
        chatApiKeyId: null,
      }),
    ).toEqual({
      agentId: "agent-1",
      modelId: undefined,
      chatApiKeyId: undefined,
    });
  });

  test("returns null when the initial selection is incomplete", () => {
    expect(
      buildCreateConversationInput({
        agentId: null,
        modelId: "",
        chatApiKeyId: null,
      }),
    ).toBeNull();
  });
});

describe("shouldResetInitialChatState", () => {
  test("does not reset when mounting directly on the initial chat route", () => {
    expect(
      shouldResetInitialChatState({
        previousRouteConversationId: undefined,
        routeConversationId: undefined,
      }),
    ).toBe(false);
  });

  test("resets when leaving a conversation route for the initial chat route", () => {
    expect(
      shouldResetInitialChatState({
        previousRouteConversationId: "conv-1",
        routeConversationId: undefined,
      }),
    ).toBe(true);
  });
});

describe("isAutoSendHandoffInProgress", () => {
  const base = {
    conversationId: undefined,
    initialUserPrompt: undefined,
    hasAttachmentsMarker: false,
    hasPendingHandoffFiles: false,
    autoSendTriggered: false,
  };

  test("true on first render of a prompt handoff (before the send fires)", () => {
    // The frame that used to flash the empty New Chat splash: /chat mounted with
    // a user_prompt, no conversation yet, auto-send not triggered.
    expect(
      isAutoSendHandoffInProgress({
        ...base,
        initialUserPrompt: "Say hello",
      }),
    ).toBe(true);
  });

  test("stays true after user_prompt is stripped from the URL (latched via ref)", () => {
    // clearUserPromptQueryParam has run, so initialUserPrompt is gone, but the
    // conversation is still being created — the ref keeps the splash suppressed.
    expect(
      isAutoSendHandoffInProgress({
        ...base,
        initialUserPrompt: undefined,
        autoSendTriggered: true,
      }),
    ).toBe(true);
  });

  test("false during an interactive submit (no handoff signals)", () => {
    // Pressing Enter on the splash runs the same create mutation, but the
    // splash must stay visible: its composer keeps focus and is the old half
    // of the shared-element morph into the conversation view. Handoffs are
    // identified by their own signals, never by the mutation being pending.
    expect(isAutoSendHandoffInProgress(base)).toBe(false);
  });

  test("true for a files-only handoff whose stashed files are still in memory", () => {
    expect(
      isAutoSendHandoffInProgress({
        ...base,
        hasAttachmentsMarker: true,
        hasPendingHandoffFiles: true,
      }),
    ).toBe(true);
  });

  test("false for a files-only handoff whose stashed files were lost (reload)", () => {
    // No prompt and no pending files: nothing will auto-send, so the composer
    // must show rather than a permanently blank pane.
    expect(
      isAutoSendHandoffInProgress({
        ...base,
        hasAttachmentsMarker: true,
        hasPendingHandoffFiles: false,
      }),
    ).toBe(false);
  });

  test("false on the plain /chat new-chat page (no handoff)", () => {
    expect(isAutoSendHandoffInProgress(base)).toBe(false);
  });

  test("false once a conversation exists, even mid-handoff signals", () => {
    // After navigating to /chat/<id> the conversation view owns the screen; the
    // suppression must not linger and blank out a real conversation.
    expect(
      isAutoSendHandoffInProgress({
        ...base,
        conversationId: "conv-1",
        initialUserPrompt: "Say hello",
        autoSendTriggered: true,
      }),
    ).toBe(false);
  });
});
