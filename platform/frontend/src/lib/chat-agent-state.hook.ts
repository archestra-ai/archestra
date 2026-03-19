import {
  type archestraApiTypes,
  SWAP_AGENT_FAILED_POKE_TEXT,
  SWAP_AGENT_POKE_PREFIX,
  SWAP_TO_DEFAULT_AGENT_POKE_TEXT,
} from "@shared";
import type { UIMessage } from "ai";
import { useMemo } from "react";

type ChatConversation = archestraApiTypes.GetChatConversationResponses["200"];
export type ChatAgentOption = { id: string; name: string };

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

  for (const message of [...messages].reverse()) {
    const swapTargetName = getSwapTargetNameFromMessage(message);
    if (swapTargetName === null) {
      continue;
    }

    if (swapTargetName === "__DEFAULT__") {
      return { id: fallbackAgentId, name: "default agent" };
    }

    const matchedAgent = agents.find((agent) => agent.name === swapTargetName);
    if (matchedAgent) {
      return { id: matchedAgent.id, name: matchedAgent.name };
    }

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
    return "__DEFAULT__";
  }

  if (!text.startsWith(SWAP_AGENT_POKE_PREFIX)) {
    return null;
  }

  const name = text
    .slice(SWAP_AGENT_POKE_PREFIX.length)
    .split(". Please continue the conversation.")[0]
    ?.trim();

  return name || null;
}
