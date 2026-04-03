import {
  type archestraApiTypes,
  SWAP_AGENT_FAILED_POKE_TEXT,
  SWAP_AGENT_POKE_AGENT_NAME_SUFFIX,
  SWAP_AGENT_POKE_PREFIX,
  SWAP_TO_DEFAULT_AGENT_POKE_TEXT,
} from "@shared";
import type { UIMessage } from "ai";
import { useMemo } from "react";

type ChatConversation = archestraApiTypes.GetChatConversationResponses["200"];
export type ChatAgentOption = { id: string; name: string };

const DEFAULT_SWAP_TARGET_NAME = "__DEFAULT__";

export type ResolvedChatAgentState = {
  conversationAgentId: string | null;
  swappedAgentId: string | null;
  swappedAgentName: string | null;
  activeAgentId: string | null;
  promptAgentId: string | null;
};

export function resolveChatAgentState(params: {
  conversation: ChatConversation | null | undefined;
  initialAgentId: string | null;
  messages?: UIMessage[];
  agents?: ChatAgentOption[];
}): ResolvedChatAgentState {
  const { conversation, initialAgentId, messages = [], agents = [] } = params;
  const conversationAgentId =
    conversation?.agentId ?? conversation?.agent?.id ?? null;
  const { id: swappedAgentId, name: swappedAgentName } = resolveSwappedAgent({
    messages,
    agents,
    fallbackAgentId: initialAgentId,
  });
  const activeAgentId = swappedAgentId ?? conversationAgentId ?? initialAgentId;
  const promptAgentId =
    swappedAgentId ?? conversation?.agent?.id ?? activeAgentId;

  return {
    conversationAgentId,
    swappedAgentId,
    swappedAgentName,
    activeAgentId,
    promptAgentId,
  };
}

export function useChatAgentState(params: {
  conversation: ChatConversation | null | undefined;
  initialAgentId: string | null;
  messages?: UIMessage[];
  agents?: ChatAgentOption[];
}): ResolvedChatAgentState {
  const { conversation, initialAgentId, messages, agents } = params;

  return useMemo(
    () =>
      resolveChatAgentState({ conversation, initialAgentId, messages, agents }),
    [conversation, initialAgentId, messages, agents],
  );
}

function resolveSwappedAgent(params: {
  messages: UIMessage[];
  agents: ChatAgentOption[];
  fallbackAgentId: string | null;
}): { id: string | null; name: string | null } {
  const { messages, agents, fallbackAgentId } = params;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const swapTargetName = getSwapTargetNameFromMessage(message);
    if (swapTargetName === null) {
      continue;
    }

    if (swapTargetName === DEFAULT_SWAP_TARGET_NAME) {
      return { id: fallbackAgentId, name: "default agent" };
    }

    const matchedAgent = agents.find((agent) => agent.name === swapTargetName);
    if (matchedAgent) {
      return { id: matchedAgent.id, name: matchedAgent.name };
    }

    // A successful swap can briefly point at a brand-new agent that has not
    // landed in the agents query cache yet. Keep the name so the UI can show
    // the new target while the selector falls back to the last concrete ID.
    return { id: null, name: swapTargetName };
  }

  return { id: null, name: null };
}

function getSwapTargetNameFromMessage(message: UIMessage): string | null {
  if (message.role !== "user") {
    return null;
  }

  const textParts = message.parts?.filter((part) => part.type === "text") ?? [];
  if (textParts.length !== 1) {
    return null;
  }

  const text = textParts[0].text;
  if (typeof text !== "string") {
    return null;
  }

  if (text === SWAP_AGENT_FAILED_POKE_TEXT) {
    return null;
  }

  if (text === SWAP_TO_DEFAULT_AGENT_POKE_TEXT) {
    return DEFAULT_SWAP_TARGET_NAME;
  }

  if (!text.startsWith(SWAP_AGENT_POKE_PREFIX)) {
    return null;
  }

  const name = text
    .slice(SWAP_AGENT_POKE_PREFIX.length)
    .split(SWAP_AGENT_POKE_AGENT_NAME_SUFFIX)[0]
    ?.trim();

  return name || null;
}
