"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  resolveChatModelState,
  resolveInitialAgentSelection,
  resolveInitialAgentState,
  resolvePreferredModelForProvider,
} from "@/app/chat/chat-initial-state";
import ArchestraPromptInput from "@/app/chat/prompt-input";
import { useDefaultAgentId, useInternalAgents } from "@/lib/agent.query";
import {
  useMemberDefaultModel,
  useUpdateMemberDefaultModel,
} from "@/lib/chat/chat.query";
import {
  deriveModelSource,
  getSavedAgent,
  saveAgent,
} from "@/lib/chat/use-chat-preferences";
import { useLlmModels, useLlmModelsByProvider } from "@/lib/llm-models.query";
import {
  type SupportedProvider,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";

/**
 * The /chat "new conversation" composer as a standalone component: the SAME
 * ArchestraPromptInput with the same agent/model/key resolution chain
 * (org default → saved pick → member default → first available) and the same
 * persistence (saved agent, member-default model). The only difference is
 * what happens on submit: the prompt is handed to `onSubmitPrompt` instead of
 * creating a conversation in place.
 *
 * Used by surfaces that start a chat elsewhere (e.g. a project page handing
 * off to /chat). Selections made here persist through the same stores the
 * /chat page reads, so the handed-off chat is created with what was picked.
 */
export function NewChatComposer({
  onSubmitPrompt,
}: {
  onSubmitPrompt: (text: string) => void;
}) {
  const { data: internalAgents = [] } = useInternalAgents();
  const { data: defaultAgentId } = useDefaultAgentId();
  const { modelsByProvider, isPending: isModelsLoading } =
    useLlmModelsByProvider();
  const { data: chatModels = [] } = useLlmModels();
  const { data: chatApiKeys = [] } = useLlmProviderApiKeys();
  const { data: organization, isPending: isOrgLoading } = useOrganization();
  const { data: memberDefault } = useMemberDefaultModel();

  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string>("");
  const [apiKeyId, setApiKeyId] = useState<string | null>(null);
  const resolvedAgentRef = useRef<(typeof internalAgents)[number] | null>(null);

  const organizationDefaults = useMemo(
    () =>
      organization
        ? {
            defaultModelId: organization.defaultModelId,
            defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
          }
        : null,
    [organization],
  );

  const applyAgentSelection = useCallback(
    (agent: (typeof internalAgents)[number]) => {
      setAgentId(agent.id);
      resolvedAgentRef.current = agent;
      const resolved = resolveInitialAgentState({
        agent,
        modelsByProvider,
        chatApiKeys,
        organization: organizationDefaults,
        memberDefault: memberDefault ?? null,
      });
      if (resolved) {
        setModelId(resolved.modelId);
        setApiKeyId(resolved.apiKeyId);
      } else {
        setModelId("");
        setApiKeyId(null);
      }
    },
    [modelsByProvider, chatApiKeys, organizationDefaults, memberDefault],
  );

  // Agent resolution, same priority as /chat:
  // org default > saved pick > member default > first available.
  useEffect(() => {
    if (agentId || internalAgents.length === 0 || isOrgLoading) return;
    const selected = resolveInitialAgentSelection({
      agents: internalAgents,
      organizationDefaultAgentId: organization?.defaultAgentId,
      savedAgentId: getSavedAgent(),
      memberDefaultAgentId: defaultAgentId,
      canUseSavedAgent: true,
    });
    if (!selected) return;
    applyAgentSelection(selected);
    saveAgent(selected.id);
  }, [
    agentId,
    internalAgents,
    isOrgLoading,
    organization?.defaultAgentId,
    defaultAgentId,
    applyAgentSelection,
  ]);

  // Model/key resolution once the agent is known (models may load later).
  const modelInitializedRef = useRef(false);
  useEffect(() => {
    if (!agentId || modelInitializedRef.current) return;
    const resolved = resolveChatModelState({
      agent: resolvedAgentRef.current,
      modelsByProvider,
      chatApiKeys,
      organization: organizationDefaults,
      memberDefault: memberDefault ?? null,
    });
    if (!resolved) return;
    setModelId(resolved.modelId);
    if (resolved.apiKeyId) setApiKeyId(resolved.apiKeyId);
    modelInitializedRef.current = true;
  }, [
    agentId,
    modelsByProvider,
    chatApiKeys,
    organizationDefaults,
    memberDefault,
  ]);

  // Persist (model, key) picks as the member default, like /chat does.
  const updateMemberDefaultModel = useUpdateMemberDefaultModel();
  const updateMemberDefaultModelRef = useRef(updateMemberDefaultModel.mutate);
  updateMemberDefaultModelRef.current = updateMemberDefaultModel.mutate;
  const apiKeyIdRef = useRef(apiKeyId);
  apiKeyIdRef.current = apiKeyId;

  const handleModelChange = useCallback((nextModelId: string) => {
    setModelId(nextModelId);
    if (apiKeyIdRef.current) {
      updateMemberDefaultModelRef.current({
        modelId: nextModelId,
        chatApiKeyId: apiKeyIdRef.current,
      });
    }
  }, []);

  const handleProviderChange = useCallback(
    (provider: SupportedProvider, nextApiKeyId: string) => {
      const preferred = resolvePreferredModelForProvider({
        provider,
        modelsByProvider,
      });
      if (preferred) {
        setModelId(preferred.modelId);
        updateMemberDefaultModelRef.current({
          modelId: preferred.modelId,
          chatApiKeyId: nextApiKeyId,
        });
      }
    },
    [modelsByProvider],
  );

  const handleAgentChange = useCallback(
    (nextAgentId: string) => {
      const agent = internalAgents.find((a) => a.id === nextAgentId);
      if (!agent) return;
      applyAgentSelection(agent);
      saveAgent(agent.id);
    },
    [internalAgents, applyAgentSelection],
  );

  const handleResetModelOverride = useCallback(() => {
    const resolved = resolveChatModelState({
      agent: resolvedAgentRef.current,
      modelsByProvider,
      chatApiKeys,
      organization: organizationDefaults,
      memberDefault: null,
    });
    if (resolved) {
      setModelId(resolved.modelId);
      setApiKeyId(resolved.apiKeyId);
    }
    updateMemberDefaultModelRef.current({ modelId: null, chatApiKeyId: null });
  }, [modelsByProvider, chatApiKeys, organizationDefaults]);

  const provider = useMemo((): SupportedProvider | undefined => {
    if (!modelId) return undefined;
    for (const [providerName, models] of Object.entries(modelsByProvider)) {
      if (models?.some((m) => m.dbId === modelId)) {
        return providerName as SupportedProvider;
      }
    }
    return undefined;
  }, [modelId, modelsByProvider]);

  const modelSource = useMemo(() => {
    const agent = internalAgents.find((a) => a.id === agentId) as
      | { modelId?: string | null }
      | undefined;
    return deriveModelSource({
      selectedModelId: modelId,
      agentModelId: agent?.modelId,
      orgModelId: organization?.defaultModelId,
    });
  }, [modelId, agentId, internalAgents, organization?.defaultModelId]);

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
          const text = message.text?.trim();
          if (!text) return;
          if (message.files && message.files.length > 0) {
            toast.warning(
              "Attachments can't be carried into the new chat yet — add them once the chat opens.",
            );
            return;
          }
          onSubmitPrompt(text);
        }}
        status="ready"
        selectedModel={modelId}
        onModelChange={handleModelChange}
        agentId={agentId}
        currentProvider={provider}
        initialApiKeyId={apiKeyId}
        onApiKeyChange={setApiKeyId}
        onProviderChange={handleProviderChange}
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
        onAgentChange={handleAgentChange}
        modelSource={modelSource}
        onResetModelOverride={handleResetModelOverride}
      />
    </div>
  );
}
