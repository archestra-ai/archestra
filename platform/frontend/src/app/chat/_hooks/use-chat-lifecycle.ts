"use client";

import type { UIMessage } from "@ai-sdk/react";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import {
  clearOAuthReauthChatResume,
  getOAuthReauthChatResume,
} from "@/lib/auth/oauth-session";
import {
  fetchConversationEnabledTools,
  useUpdateConversationEnabledTools,
} from "@/lib/chat/chat.query";
import {
  applyPendingActions,
  clearPendingActions,
  getPendingActions,
} from "@/lib/chat/pending-tool-state";

type LifecycleStatus =
  | "idle"
  | "creatingConversation"
  | "waitingForSession"
  | "ready"
  | "streaming";

type LifecycleState = {
  status: LifecycleStatus;
};

type LifecycleAction =
  | { type: "creating" }
  | { type: "waitingForSession" }
  | { type: "ready" }
  | { type: "streaming" };

type PendingInitialMessage = {
  text: string;
  files: Array<{ url: string; mediaType: string; filename?: string }>;
};

type SendMessage = (message: {
  role: "user";
  parts: Array<
    | { type: "text"; text: string }
    | { type: "file"; url: string; mediaType: string; filename?: string }
  >;
  metadata: { createdAt: string };
}) => void;

export function useChatLifecycle(params: {
  conversationId: string | undefined;
  conversation:
    | {
        id: string;
        messages: unknown[];
      }
    | null
    | undefined;
  messagesLength: number;
  status: string;
  sendMessage: SendMessage | undefined;
  setMessages: ((messages: UIMessage[]) => void) | undefined;
  initialUserPrompt: string | undefined;
  initialAgentId: string | null;
  isCreateConversationPending: boolean;
  isPlaywrightSetupVisible: boolean;
  createInitialConversation: (
    onSuccess?: (newConversation: { id: string }) => void | Promise<void>,
  ) => boolean;
  selectConversation: (id: string | undefined) => void;
  queryClient: QueryClient;
}) {
  const [lifecycleState, dispatch] = useReducer(lifecycleReducer, {
    status: "idle",
  });
  const pendingInitialMessageRef = useRef<PendingInitialMessage | null>(null);
  const pendingInitialSendConversationRef = useRef<string | undefined>(
    undefined,
  );
  const autoSendTriggeredRef = useRef(false);
  const oauthReauthResumeTriggeredRef = useRef(false);
  const updateEnabledToolsMutation = useUpdateConversationEnabledTools();

  useEffect(() => {
    if (params.status === "streaming" || params.status === "submitted") {
      dispatch({ type: "streaming" });
    } else if (params.status === "ready") {
      dispatch({ type: "ready" });
    }
  }, [params.status]);

  useEffect(() => {
    if (!params.setMessages || !params.sendMessage) {
      return;
    }

    const pendingMessage = pendingInitialMessageRef.current;
    const hasPendingInitialMessage =
      !!pendingMessage &&
      (!!pendingMessage.text || pendingMessage.files.length > 0);
    const shouldSendPendingInitialMessage =
      params.conversationId &&
      params.conversation?.id === params.conversationId &&
      params.conversation.messages.length === 0 &&
      params.messagesLength === 0 &&
      params.status === "ready" &&
      hasPendingInitialMessage &&
      pendingInitialSendConversationRef.current !== params.conversationId;

    if (!shouldSendPendingInitialMessage || !pendingMessage) {
      return;
    }

    pendingInitialSendConversationRef.current = params.conversationId;
    pendingInitialMessageRef.current = null;

    params.sendMessage({
      role: "user",
      parts: buildMessageParts(pendingMessage),
      metadata: { createdAt: new Date().toISOString() },
    });
  }, [
    params.conversation,
    params.conversationId,
    params.messagesLength,
    params.sendMessage,
    params.setMessages,
    params.status,
  ]);

  useEffect(() => {
    if (autoSendTriggeredRef.current || !params.initialUserPrompt) return;
    if (params.conversationId) return;
    if (!params.initialAgentId) return;
    if (params.isCreateConversationPending) return;

    autoSendTriggeredRef.current = true;
    pendingInitialMessageRef.current = {
      text: params.initialUserPrompt,
      files: [],
    };
    dispatch({ type: "creating" });

    params.createInitialConversation((newConversation) => {
      dispatch({ type: "waitingForSession" });
      params.selectConversation(newConversation.id);
    });
  }, [
    params.initialUserPrompt,
    params.conversationId,
    params.initialAgentId,
    params.createInitialConversation,
    params.selectConversation,
    params.isCreateConversationPending,
  ]);

  useEffect(() => {
    const pendingReauthResume = getOAuthReauthChatResume();
    if (
      oauthReauthResumeTriggeredRef.current ||
      !pendingReauthResume ||
      pendingReauthResume.conversationId !== params.conversationId ||
      !params.sendMessage ||
      params.status !== "ready"
    ) {
      return;
    }

    oauthReauthResumeTriggeredRef.current = true;
    clearOAuthReauthChatResume();
    params.sendMessage({
      role: "user",
      parts: [{ type: "text", text: pendingReauthResume.message }],
      metadata: { createdAt: new Date().toISOString() },
    });
  }, [params.conversationId, params.sendMessage, params.status]);

  const submitInitialMessage = useCallback(
    (message: Partial<PromptInputMessage>) => {
      if (params.isPlaywrightSetupVisible) return;
      const hasText = message.text?.trim();
      const hasFiles = message.files && message.files.length > 0;

      if (
        (!hasText && !hasFiles) ||
        !params.initialAgentId ||
        params.isCreateConversationPending
      ) {
        return;
      }

      pendingInitialMessageRef.current = {
        text: message.text || "",
        files: message.files || [],
      };

      const pendingActions = getPendingActions(params.initialAgentId);
      dispatch({ type: "creating" });

      params.createInitialConversation(async (newConversation) => {
        if (pendingActions.length > 0) {
          try {
            const enabledToolsResult = await fetchConversationEnabledTools(
              newConversation.id,
            );
            if (enabledToolsResult?.data) {
              const baseEnabledToolIds =
                enabledToolsResult.data.enabledToolIds || [];
              const newEnabledToolIds = applyPendingActions(
                baseEnabledToolIds,
                pendingActions,
              );

              params.queryClient.setQueryData(
                ["conversation", newConversation.id, "enabled-tools"],
                {
                  hasCustomSelection: true,
                  enabledToolIds: newEnabledToolIds,
                },
              );

              updateEnabledToolsMutation.mutate({
                conversationId: newConversation.id,
                toolIds: newEnabledToolIds,
              });
            }
          } catch {
            // Keep the existing behavior: default tools are used if this fails.
          }
          clearPendingActions();
        }

        dispatch({ type: "waitingForSession" });
        params.selectConversation(newConversation.id);
      });
    },
    [
      params.isPlaywrightSetupVisible,
      params.initialAgentId,
      params.isCreateConversationPending,
      params.createInitialConversation,
      params.queryClient,
      params.selectConversation,
      updateEnabledToolsMutation,
    ],
  );

  return {
    lifecycleStatus: lifecycleState.status,
    submitInitialMessage,
  };
}

function lifecycleReducer(
  _state: LifecycleState,
  action: LifecycleAction,
): LifecycleState {
  switch (action.type) {
    case "creating":
      return { status: "creatingConversation" };
    case "waitingForSession":
      return { status: "waitingForSession" };
    case "ready":
      return { status: "ready" };
    case "streaming":
      return { status: "streaming" };
  }
}

function buildMessageParts(message: PendingInitialMessage) {
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "file"; url: string; mediaType: string; filename?: string }
  > = [];

  if (message.text) {
    parts.push({ type: "text", text: message.text });
  }

  for (const file of message.files) {
    parts.push({
      type: "file",
      url: file.url,
      mediaType: file.mediaType,
      filename: file.filename,
    });
  }

  return parts;
}
