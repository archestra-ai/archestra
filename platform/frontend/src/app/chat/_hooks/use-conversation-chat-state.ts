"use client";

import type { UIMessage } from "@ai-sdk/react";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { PartialUIMessage } from "@/components/message-thread";
import { useConversation } from "@/lib/chat/chat.query";
import { useChatAgentState } from "@/lib/chat/chat-agent-state.hook";
import { useChatSession } from "@/lib/chat/global-chat.context";
import { mergePersistedMessageMetadata } from "../_utils/chat-message-metadata";

type ConversationAgentOption = {
  id: string;
  name: string;
};

export function useConversationChatState(params: {
  conversationId: string | undefined;
  routeConversationId: string | undefined;
  sessionUserId: string | undefined;
  initialAgentId: string | null;
  agents: ConversationAgentOption[];
  queryClient: QueryClient;
}) {
  const { data: conversation, isLoading: isLoadingConversation } =
    useConversation(params.conversationId);
  const canManageShare =
    !!params.conversationId &&
    !!conversation &&
    conversation.userId === params.sessionUserId;
  const isShared = !!conversation?.share;
  const isReadOnlySharedConversation =
    !!params.conversationId &&
    !!conversation?.share &&
    conversation.userId !== params.sessionUserId;
  const persistedConversationMessages = useMemo(
    () => (conversation?.messages ?? []) as UIMessage[],
    [conversation?.messages],
  );
  const shouldEnableChatSession =
    !!params.conversationId &&
    !isReadOnlySharedConversation &&
    (!params.routeConversationId || !!conversation);
  const chatSession = useChatSession({
    conversationId: shouldEnableChatSession ? params.conversationId : undefined,
    initialMessages: persistedConversationMessages,
    enabled: shouldEnableChatSession,
  });
  const sharedConversationMessages = useMemo(
    () => (conversation?.messages ?? []) as PartialUIMessage[],
    [conversation?.messages],
  );

  const messages = useMemo(
    () =>
      chatSession?.messages
        ? mergePersistedMessageMetadata({
            liveMessages: chatSession.messages,
            persistedMessages: persistedConversationMessages,
          })
        : persistedConversationMessages,
    [chatSession?.messages, persistedConversationMessages],
  );
  const status = chatSession?.status ?? "ready";
  const error =
    status === "submitted" || status === "streaming"
      ? undefined
      : chatSession?.error;

  const {
    conversationAgentId,
    activeAgentId,
    promptAgentId,
    swappedAgentName,
  } = useChatAgentState({
    conversation,
    initialAgentId: params.initialAgentId,
    messages,
    agents: params.agents,
  });

  useEffect(() => {
    if (
      !params.conversationId ||
      status === "streaming" ||
      status === "submitted"
    ) {
      return;
    }

    const lastMsg = conversation?.messages?.at(-1) as UIMessage | undefined;
    const isWaitingForAssistant =
      lastMsg?.role === "user" && messages.length > 0;

    if (!isWaitingForAssistant) return;

    const interval = setInterval(() => {
      params.queryClient.invalidateQueries({
        queryKey: ["conversation", params.conversationId],
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [
    params.conversationId,
    conversation?.messages,
    messages.length,
    status,
    params.queryClient,
  ]);

  return {
    activeAgentId,
    addToolApprovalResponse: chatSession?.addToolApprovalResponse,
    addToolResult: chatSession?.addToolResult,
    canManageShare,
    chatSession,
    conversation,
    conversationAgentId,
    error,
    isLoadingConversation,
    isReadOnlySharedConversation,
    isShared,
    messages,
    optimisticToolCalls: chatSession?.optimisticToolCalls ?? [],
    pendingCustomServerToolCall: chatSession?.pendingCustomServerToolCall,
    promptAgentId,
    sendMessage: chatSession?.sendMessage,
    setMessages: chatSession?.setMessages,
    setPendingCustomServerToolCall: chatSession?.setPendingCustomServerToolCall,
    sharedConversationMessages,
    status,
    stop: chatSession?.stop,
    swappedAgentName,
    tokenUsage: chatSession?.tokenUsage,
  };
}
