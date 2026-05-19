import type { archestraApiTypes } from "@shared";
import { describe, expect, test } from "vitest";
import { mergeUpdatedConversationIntoCache } from "./chat.query";

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
      modelId: "model-claude",
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
    expect(merged.modelId).toBe("model-claude");
    expect(merged.chatApiKeyId).toBe("key-anthropic");
  });

  test("keeps unrelated fields stable for a model-only update", () => {
    const oldConversation = makeConversation();
    const updatedConversation = {
      ...oldConversation,
      modelId: "model-gpt41",
    } satisfies archestraApiTypes.UpdateChatConversationResponses["200"];

    const merged = mergeUpdatedConversationIntoCache(
      oldConversation,
      updatedConversation,
      {
        id: "conversation-1",
        modelId: "model-gpt41",
      },
    );

    expect(merged.agentId).toBe("agent-a");
    expect(merged.chatApiKeyId).toBe("key-openai");
    expect(merged.modelId).toBe("model-gpt41");
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
    modelId: null,
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
