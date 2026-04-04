import {
  type archestraApiTypes,
  makeSwapAgentPokeText,
  SWAP_AGENT_FAILED_POKE_TEXT,
  SWAP_TO_DEFAULT_AGENT_POKE_TEXT,
} from "@shared";
import type { UIMessage } from "ai";
import { describe, expect, test } from "vitest";
import {
  type ChatAgentOption,
  resolveChatAgentState,
} from "./chat-agent-state.hook";

describe("resolveChatAgentState", () => {
  test("prefers the conversation agentId when present", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: "agent-b",
        agent: makeConversationAgent("agent-b", "Agent B"),
      }),
      initialAgentId: "agent-a",
    });

    expect(state.conversationAgentId).toBe("agent-b");
    expect(state.swappedAgentId).toBeNull();
    expect(state.swappedAgentName).toBeNull();
    expect(state.activeAgentId).toBe("agent-b");
    expect(state.promptAgentId).toBe("agent-b");
  });

  test("falls back to the conversation agent object id when agentId is missing", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: null,
        agent: makeConversationAgent("agent-b", "Agent B"),
      }),
      initialAgentId: "agent-a",
    });

    expect(state.conversationAgentId).toBe("agent-b");
    expect(state.swappedAgentId).toBeNull();
    expect(state.swappedAgentName).toBeNull();
    expect(state.activeAgentId).toBe("agent-b");
    expect(state.promptAgentId).toBe("agent-b");
  });

  test("falls back to the initial agent when the conversation agent is unavailable", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: null,
        agent: null,
      }),
      initialAgentId: "agent-a",
    });

    expect(state.conversationAgentId).toBeNull();
    expect(state.swappedAgentId).toBeNull();
    expect(state.swappedAgentName).toBeNull();
    expect(state.activeAgentId).toBe("agent-a");
    expect(state.promptAgentId).toBe("agent-a");
  });

  test("prefers the most recent successful swapped agent from live messages", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: "agent-a",
        agent: makeConversationAgent("agent-a", "Agent A"),
      }),
      initialAgentId: "agent-a",
      agents: makeAgents(),
      messages: [makeUserMessage(makeSwapAgentPokeText("Test Agent"))],
    });

    expect(state.conversationAgentId).toBe("agent-a");
    expect(state.swappedAgentId).toBe("agent-test");
    expect(state.swappedAgentName).toBe("Test Agent");
    expect(state.activeAgentId).toBe("agent-test");
    expect(state.promptAgentId).toBe("agent-test");
  });

  test("uses the latest swap poke when multiple swap messages exist", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: "agent-a",
        agent: makeConversationAgent("agent-a", "Agent A"),
      }),
      initialAgentId: "agent-a",
      agents: makeAgents(),
      messages: [
        makeUserMessage(makeSwapAgentPokeText("Agent B")),
        makeUserMessage(makeSwapAgentPokeText("Test Agent")),
      ],
    });

    expect(state.swappedAgentId).toBe("agent-test");
    expect(state.swappedAgentName).toBe("Test Agent");
    expect(state.activeAgentId).toBe("agent-test");
  });

  test("falls back to the default agent after swap_to_default poke", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: "agent-test",
        agent: makeConversationAgent("agent-test", "Test Agent"),
      }),
      initialAgentId: "agent-a",
      agents: makeAgents(),
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: SWAP_TO_DEFAULT_AGENT_POKE_TEXT }],
        },
      ],
    });

    expect(state.swappedAgentId).toBe("agent-a");
    expect(state.swappedAgentName).toBe("default agent");
    expect(state.activeAgentId).toBe("agent-a");
    expect(state.promptAgentId).toBe("agent-a");
  });

  test("ignores failed swap poke messages", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: "agent-a",
        agent: makeConversationAgent("agent-a", "Agent A"),
      }),
      initialAgentId: "agent-a",
      agents: makeAgents(),
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: SWAP_AGENT_FAILED_POKE_TEXT }],
        },
      ],
    });

    expect(state.swappedAgentId).toBeNull();
    expect(state.swappedAgentName).toBeNull();
    expect(state.activeAgentId).toBe("agent-a");
    expect(state.promptAgentId).toBe("agent-a");
  });

  test("preserves swapped agent name even before the new agent appears in the agent list", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: "agent-a",
        agent: makeConversationAgent("agent-a", "Agent A"),
      }),
      initialAgentId: "agent-a",
      agents: makeAgents().filter((agent) => agent.id !== "agent-test"),
      messages: [makeUserMessage(makeSwapAgentPokeText("Test Agent"))],
    });

    expect(state.swappedAgentId).toBeNull();
    expect(state.swappedAgentName).toBe("Test Agent");
    expect(state.activeAgentId).toBe("agent-a");
    expect(state.promptAgentId).toBe("agent-a");
  });
});

function makeAgents(): ChatAgentOption[] {
  return [
    { id: "agent-a", name: "Agent A" },
    { id: "agent-b", name: "Agent B" },
    { id: "agent-test", name: "Test Agent" },
  ];
}

function makeUserMessage(text: string): UIMessage {
  return {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function makeConversationAgent(id: string, name: string) {
  return {
    id,
    name,
    systemPrompt: null,
    agentType: "agent" as const,
    llmApiKeyId: null,
  };
}

function makeConversation(
  overrides: Partial<
    archestraApiTypes.GetChatConversationResponses["200"]
  > = {},
): archestraApiTypes.GetChatConversationResponses["200"] {
  return {
    id: "conversation-1",
    userId: "user-1",
    organizationId: "org-1",
    agentId: "agent-a",
    chatApiKeyId: null,
    title: "Test",
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    hasCustomToolSelection: false,
    todoList: null,
    artifact: null,
    pinnedAt: null,
    createdAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:00.000Z",
    agent: {
      id: "agent-a",
      name: "Agent A",
      systemPrompt: null,
      agentType: "agent",
      llmApiKeyId: null,
    },
    share: null,
    messages: [],
    ...overrides,
  };
}
