"use client";

import type { FileUIPart } from "ai";
import { useMemo } from "react";
import ArchestraPromptInput from "@/app/chat/prompt-input";
import { AgentRuntimeCredentialPrompt } from "@/components/agent-run-credential-prompt";
import { useDefaultAgentId, useInternalAgents } from "@/lib/agent.query";
import { useAgentRuntimePreflight } from "@/lib/agent-runtime.query";
import { useMemberDefaultModel } from "@/lib/chat/chat.query";
import { useInitialChatModelState } from "@/lib/chat/use-initial-chat-model-state.hook";
import { useFeature } from "@/lib/config/config.query";
import { useLlmModels, useLlmModelsByProvider } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { ViewTransition } from "@/lib/view-transition";

/**
 * The /chat "new conversation" composer as a standalone component: the SAME
 * ArchestraPromptInput driven by the shared new-chat resolution chain
 * (project default → org default → saved pick → member default → first
 * available) and the same persistence (saved agent, member-default model). The
 * only difference is what happens on submit: the prompt is handed to
 * `onSubmitPrompt` instead of creating a conversation in place.
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
  projectDefaultAgentId,
  isProjectLoading,
  isSubmitting = false,
}: {
  onSubmit: (submission: {
    text: string;
    agentId: string;
    modelId: string;
    apiKeyId: string | null;
    files: FileUIPart[];
    runtimeMode: boolean;
  }) => void;
  /** The pinned agent of the project this composer starts chats in, if any. */
  projectDefaultAgentId?: string | null;
  /**
   * Set while that project is still loading. Agent resolution runs once, so a
   * caller that mounts this before the pin arrives must say so or the pin is
   * lost to the org default. Callers that render only after the project has
   * loaded can omit it.
   */
  isProjectLoading?: boolean;
  isSubmitting?: boolean;
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
    projectDefaultAgentId,
    isProjectLoading,
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

  const runtimeEnabled = useFeature("agentRuntime") === true;
  const runtimeAgent = runtimeEnabled
    ? internalAgents.find(
        (agent) => agent.id === agentId && agent.runtime !== null,
      )
    : undefined;
  const isRuntimeMode = !!runtimeAgent;
  const runtimePreflight = useAgentRuntimePreflight(
    agentId ?? "",
    isRuntimeMode,
  );

  if (!agentId) return null;

  return (
    // Shared-element pair with the /chat composer: when the started chat
    // navigates to /chat/<id>, the composer morphs from its spot on this page
    // to the conversation's bottom-anchored composer instead of hard-cutting.
    <ViewTransition
      name="chat-composer"
      share="chat-composer-morph"
      default="none"
    >
      {/* auto-height wrapper: ArchestraPromptInput's own `size-full
          justify-end` shell (built for the bottom-anchored /chat layout)
          collapses against it instead of stretching to the surrounding
          column. */}
      <div className="w-full">
        <ArchestraPromptInput
          onSubmit={(message) => {
            const text = message.text?.trim() ?? "";
            const files = message.files ?? [];
            if (!text && files.length === 0) return;
            if (isRuntimeMode && !text) return;
            onSubmit({
              text,
              agentId,
              modelId,
              apiKeyId,
              files,
              runtimeMode: isRuntimeMode,
            });
          }}
          status={isSubmitting ? "submitted" : "ready"}
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
          isPlaywrightSetupRequired={false}
          selectorAgentId={agentId}
          onAgentChange={onAgentChange}
          modelSource={modelSource}
          onResetModelOverride={onResetModelOverride}
          sendDisabled={
            isRuntimeMode &&
            (runtimePreflight.isPending ||
              runtimePreflight.data?.ready !== true)
          }
          runtimeMode={isRuntimeMode}
          runtimeAgentName={runtimeAgent?.name}
        />
        {isRuntimeMode && runtimePreflight.data?.ready === false && (
          <AgentRuntimeCredentialPrompt
            agentId={agentId}
            missing={[
              ...runtimePreflight.data.missing,
              ...runtimePreflight.data.misconfigured,
            ]}
            declarations={runtimeAgent?.runtime?.credentials ?? []}
            onConnected={() => runtimePreflight.refetch()}
          />
        )}
      </div>
    </ViewTransition>
  );
}
