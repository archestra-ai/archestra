"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearModelOverride,
  getSavedAgent,
  type ModelSource,
  saveAgent,
  saveModelOverride,
} from "@/lib/chat/use-chat-preferences";
import type { SupportedProvider } from "@/lib/llm-provider-api-keys.query";
import {
  resolveChatModelState,
  resolveInitialAgentState,
  resolvePreferredModelForProvider,
} from "../_utils/chat-initial-state";

type SearchParamsLike = {
  get(name: string): string | null;
};

type InitialChatAgent = {
  id: string;
  llmModel?: string | null;
  llmApiKeyId?: string | null;
};

type ChatApiKeyInfo = {
  id: string;
  provider: SupportedProvider;
  bestModelId?: string | null;
};

type OrganizationInfo = {
  defaultAgentId?: string | null;
  defaultLlmModel?: string | null;
  defaultLlmApiKeyId?: string | null;
} | null;

export function useInitialChatState(params: {
  internalAgents: InitialChatAgent[];
  defaultAgentId: string | null | undefined;
  searchParams: SearchParamsLike;
  chatApiKeys: ChatApiKeyInfo[];
  organization: OrganizationInfo;
  isOrgLoading: boolean;
}) {
  const [initialAgentId, setInitialAgentId] = useState<string | null>(null);
  const [initialModel, setInitialModel] = useState<string>("");
  const [initialApiKeyId, setInitialApiKeyId] = useState<string | null>(null);
  const [initialModelSource, setInitialModelSource] =
    useState<ModelSource | null>(null);
  const urlParamsConsumedRef = useRef<string | null>(null);
  const resolvedAgentRef = useRef<InitialChatAgent | null>(null);
  const modelInitializedRef = useRef(false);
  const modelSelectorWasOpenRef = useRef(false);

  const applyInitialAgentSelection = useCallback(
    (agent: InitialChatAgent) => {
      setInitialAgentId(agent.id);
      resolvedAgentRef.current = agent;

      const resolved = resolveInitialAgentState({
        agent,
        chatApiKeys: params.chatApiKeys,
        organization: params.organization
          ? {
              defaultLlmModel: params.organization.defaultLlmModel,
              defaultLlmApiKeyId: params.organization.defaultLlmApiKeyId,
            }
          : null,
      });

      if (resolved) {
        setInitialModel(resolved.modelId);
        setInitialApiKeyId(resolved.apiKeyId);
        setInitialModelSource(resolved.modelSource);
      } else {
        setInitialModel("");
        setInitialApiKeyId(null);
        setInitialModelSource(null);
      }
    },
    [params.chatApiKeys, params.organization],
  );

  useEffect(() => {
    if (params.internalAgents.length === 0) return;
    if (params.isOrgLoading) return;

    const urlAgentId = params.searchParams.get("agentId");
    if (urlAgentId && urlAgentId !== urlParamsConsumedRef.current) {
      const matchingAgent = params.internalAgents.find(
        (agent) => agent.id === urlAgentId,
      );
      if (matchingAgent) {
        applyInitialAgentSelection(matchingAgent);
        urlParamsConsumedRef.current = urlAgentId;
        return;
      }
    }

    if (!initialAgentId && !urlParamsConsumedRef.current) {
      if (params.organization?.defaultAgentId) {
        const orgDefaultAgent = params.internalAgents.find(
          (agent) => agent.id === params.organization?.defaultAgentId,
        );
        if (orgDefaultAgent) {
          applyInitialAgentSelection(orgDefaultAgent);
          saveAgent(params.organization.defaultAgentId);
          return;
        }
      }

      const savedAgentId = getSavedAgent();
      const savedAgent = params.internalAgents.find(
        (agent) => agent.id === savedAgentId,
      );
      if (savedAgent) {
        applyInitialAgentSelection(savedAgent);
        return;
      }

      if (params.defaultAgentId) {
        const defaultAgent = params.internalAgents.find(
          (agent) => agent.id === params.defaultAgentId,
        );
        if (defaultAgent) {
          applyInitialAgentSelection(defaultAgent);
          saveAgent(params.defaultAgentId);
          return;
        }
      }

      applyInitialAgentSelection(params.internalAgents[0]);
      saveAgent(params.internalAgents[0].id);
    }
  }, [
    applyInitialAgentSelection,
    initialAgentId,
    params.searchParams,
    params.internalAgents,
    params.defaultAgentId,
    params.organization?.defaultAgentId,
    params.isOrgLoading,
  ]);

  useEffect(() => {
    if (!initialAgentId) return;
    if (modelInitializedRef.current) return;

    const resolved = resolveChatModelState({
      agent: resolvedAgentRef.current,
      chatApiKeys: params.chatApiKeys,
      organization: params.organization
        ? {
            defaultLlmModel: params.organization.defaultLlmModel,
            defaultLlmApiKeyId: params.organization.defaultLlmApiKeyId,
          }
        : null,
    });

    if (!resolved) return;

    setInitialModel(resolved.modelId);
    setInitialModelSource(resolved.modelSource);
    if (resolved.apiKeyId) {
      setInitialApiKeyId(resolved.apiKeyId);
    }
    modelInitializedRef.current = true;
  }, [
    initialAgentId,
    params.chatApiKeys,
    params.organization?.defaultLlmModel,
    params.organization?.defaultLlmApiKeyId,
    params.organization,
  ]);

  const handleInitialModelChange = useCallback((modelId: string) => {
    if (modelInitializedRef.current && !modelSelectorWasOpenRef.current) {
      return;
    }
    setInitialModel(modelId);
    if (modelSelectorWasOpenRef.current) {
      setInitialModelSource("user");
      saveModelOverride(modelId);
    }
    modelSelectorWasOpenRef.current = false;
  }, []);

  const handleInitialModelSelectorOpenChange = useCallback((open: boolean) => {
    if (open) {
      modelSelectorWasOpenRef.current = true;
    }
  }, []);

  const handleInitialProviderChange = useCallback(
    (newProvider: SupportedProvider, apiKeyId: string) => {
      const preferredModel = resolvePreferredModelForProvider({
        provider: newProvider,
        apiKeyId,
        chatApiKeys: params.chatApiKeys,
      });
      if (preferredModel) {
        setInitialModel(preferredModel.modelId);
        setInitialModelSource("user");
        saveModelOverride(preferredModel.modelId);
      }
    },
    [params.chatApiKeys],
  );

  const handleResetModelOverride = useCallback(() => {
    clearModelOverride();
    modelInitializedRef.current = false;

    const resolved = resolveChatModelState({
      agent: resolvedAgentRef.current,
      chatApiKeys: params.chatApiKeys,
      organization: params.organization
        ? {
            defaultLlmModel: params.organization.defaultLlmModel,
            defaultLlmApiKeyId: params.organization.defaultLlmApiKeyId,
          }
        : null,
    });

    if (resolved) {
      setInitialModel(resolved.modelId);
      setInitialApiKeyId(resolved.apiKeyId);
      setInitialModelSource(resolved.modelSource);
    } else {
      setInitialModel("");
      setInitialApiKeyId(null);
      setInitialModelSource(null);
    }
    modelInitializedRef.current = true;
  }, [params.chatApiKeys, params.organization]);

  const resetInitialChatState = useCallback(() => {
    setInitialAgentId(null);
    setInitialModel("");
    setInitialApiKeyId(null);
    setInitialModelSource(null);
    modelInitializedRef.current = false;
  }, []);

  const handleInitialAgentChange = useCallback(
    (agentId: string) => {
      setInitialAgentId(agentId);
      saveAgent(agentId);

      const selectedAgent = params.internalAgents.find(
        (agent) => agent.id === agentId,
      );
      if (selectedAgent) {
        applyInitialAgentSelection(selectedAgent);
      }
    },
    [applyInitialAgentSelection, params.internalAgents],
  );

  return {
    handleInitialAgentChange,
    handleInitialModelChange,
    handleInitialModelSelectorOpenChange,
    handleInitialProviderChange,
    handleResetModelOverride,
    initialAgentId,
    initialApiKeyId,
    initialModel,
    initialModelSource,
    resetInitialChatState,
    setInitialApiKeyId,
  };
}
