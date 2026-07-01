"use client";

import { useMemo } from "react";
import ArchestraPromptInput from "@/app/chat/prompt-input";
import { useDefaultAgentId, useInternalAgents } from "@/lib/agent.query";
import { useMemberDefaultModel } from "@/lib/chat/chat.query";
import { setPendingChatHandoffFiles } from "@/lib/chat/pending-chat-handoff-files";
import { useInitialChatModelState } from "@/lib/chat/use-initial-chat-model-state.hook";
import { useLlmModels, useLlmModelsByProvider } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";

/**
 * The /chat "new conversation" composer as a standalone component: the SAME
 * ArchestraPromptInput driven by the shared new-chat resolution chain
 * (org default → saved pick → member default → first available) and the same
 * persistence (saved agent, member-default model). The only difference is
 * what happens on submit: the prompt is handed to `onSubmitPrompt` instead of
 * creating a conversation in place.
 *
 * Used by surfaces that start a chat elsewhere (e.g. a project page). The
 * resolved agent/model/key are handed to `onSubmit` alongside the prompt so the
 * caller can create the conversation itself — the saved pick alone is not
 * authoritative (the /chat resolution chain ranks the org default and the
 * permission-gated saved pick), so the choice must travel with the handoff.
 * Attachments are too large for that call, so they ride the in-memory
 * {@link setPendingChatHandoffFiles} store; the caller drains them once the
 * conversation exists.
 */
export function NewChatComposer({
  onSubmit,
}: {
  onSubmit: (submission: {
    text: string;
    agentId: string;
    modelId: string;
    apiKeyId: string | null;
  }) => void;
}) {
  const { data: internalAgents = [] } = useInternalAgents();
  const { data: defaultAgentId } = useDefaultAgentId();
  const { modelsByProvider, isPending: isModelsLoading } =
    useLlmModelsByProvider();
  const { data: chatModels = [] } = useLlmModels();
  const { data: chatApiKeys = [] } = useLlmProviderApiKeys();
  const { data: organization, isPending: isOrgLoading } = useOrganization();
  const { data: memberDefault } = useMemberDefaultModel();

  const {
    agentId,
    modelId,
    apiKeyId,
    provider,
    modelSource,
    setApiKeyId,
    onAgentChange,
    onModelChange,
    onProviderChange,
    onResetModelOverride,
  } = useInitialChatModelState({
    agents: internalAgents,
    organization: organization ?? null,
    defaultAgentId,
    modelsByProvider,
    chatApiKeys,
    memberDefault: memberDefault ?? null,
    canUseSavedAgent: true,
    isPermissionResolving: false,
    isOrgLoading,
  });

  const inputModalities = useMemo(() => {
    if (!modelId) return null;
    const model = chatModels.find((m) => m.dbId === modelId);
    return model?.capabilities?.inputModalities ?? null;
  }, [modelId, chatModels]);

  if (!agentId) return null;

  return (
    // auto-height wrapper: ArchestraPromptInput's own `size-full justify-end`
    // shell (built for the bottom-anchored /chat layout) collapses against it
    // instead of stretching to the surrounding column.
    <div className="w-full">
      <ArchestraPromptInput
        onSubmit={(message) => {
          const text = message.text?.trim() ?? "";
          const files = message.files ?? [];
          // Nothing to start a chat with.
          if (!text && files.length === 0) return;
          // Data URLs are too large to pass inline, so stash attachments in
          // memory for the caller to drain once the conversation exists. Always
          // set — an empty array clears any abandoned prior set so a text-only
          // handoff never inherits stale files.
          setPendingChatHandoffFiles(files);
          onSubmit({ text, agentId, modelId, apiKeyId });
        }}
        status="ready"
        selectedModel={modelId}
        onModelChange={onModelChange}
        agentId={agentId}
        currentProvider={provider}
        initialApiKeyId={apiKeyId}
        onApiKeyChange={setApiKeyId}
        onProviderChange={onProviderChange}
        allowFileUploads={organization?.allowChatFileUploads ?? false}
        isModelsLoading={isModelsLoading}
        inputModalities={inputModalities}
        agentLlmApiKeyId={
          (
            internalAgents.find((a) => a.id === agentId) as
              | Record<string, unknown>
              | undefined
          )?.llmApiKeyId as string | null
        }
        isPlaywrightSetupVisible={false}
        selectorAgentId={agentId}
        onAgentChange={onAgentChange}
        modelSource={modelSource}
        onResetModelOverride={onResetModelOverride}
      />
    </div>
  );
}
