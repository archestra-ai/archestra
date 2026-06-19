import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveChatModelState,
  resolveInitialAgentSelection,
  resolveInitialAgentState,
  resolvePreferredModelForProvider,
  shouldResetInitialChatState,
} from "@/app/chat/chat-initial-state";
import type { LlmModel } from "@/lib/llm-models.query";
import type { SupportedProvider } from "@/lib/llm-provider-api-keys.query";
import { useUpdateMemberDefaultModel } from "./chat.query";
import {
  deriveModelSource,
  getSavedAgent,
  type ModelSource,
  saveAgent,
} from "./use-chat-preferences";

/** The minimal agent shape the resolution chain reads. */
type InitialChatAgent = {
  id: string;
  modelId?: string | null;
  llmApiKeyId?: string | null;
};

type InitialChatOrganization = {
  defaultAgentId?: string | null;
  defaultModelId?: string | null;
  defaultLlmApiKeyId?: string | null;
} | null;

type InitialChatMemberDefault = {
  modelId?: string | null;
  chatApiKeyId?: string | null;
} | null;

type InitialChatModelStateParams<TAgent extends InitialChatAgent> = {
  // ---- already-fetched data, passed in by the caller (NO queries inside) ----
  agents: TAgent[];
  organization: InitialChatOrganization;
  defaultAgentId: string | null | undefined;
  modelsByProvider: Record<string, LlmModel[]>;
  chatApiKeys: { id: string; provider: string }[];
  memberDefault: InitialChatMemberDefault;
  // ---- caller-owned policy, kept explicit at the boundary ----
  /** Resolve to this agent if it is present (page passes the URL param). */
  urlAgentId?: string | null;
  /** Honor the localStorage saved-agent step (page gates this on RBAC). */
  canUseSavedAgent: boolean;
  /** Hold resolution until the caller's permission flags settle. */
  isPermissionResolving: boolean;
  /** Hold resolution until the organization data is available. */
  isOrgLoading: boolean;
  /**
   * The conversation id from the route, if any. When it transitions from a
   * conversation to the initial chat route (defined -> undefined), the resolved
   * agent/model/key are reset so a fresh new chat re-resolves from scratch.
   */
  routeConversationId?: string;
};

export type InitialChatModelState = {
  agentId: string | null;
  modelId: string;
  apiKeyId: string | null;
  provider: SupportedProvider | undefined;
  modelSource: ModelSource | null;
  setApiKeyId: (apiKeyId: string | null) => void;
  onAgentChange: (agentId: string) => void;
  onModelChange: (modelId: string) => void;
  onProviderChange: (provider: SupportedProvider, apiKeyId: string) => void;
  onResetModelOverride: () => void;
};

/**
 * The shared new-chat initialization orchestration: the agent/model/key
 * resolution chain (org default > saved pick > member default > first), the
 * resolution effects, member-default persistence, and the change handlers.
 *
 * It does NO data fetching — every query result is passed in so query policy
 * (which queries run and when they are enabled) stays at the caller boundary.
 * Both the /chat page and the project handoff composer consume it.
 */
export function useInitialChatModelState<TAgent extends InitialChatAgent>(
  params: InitialChatModelStateParams<TAgent>,
): InitialChatModelState {
  const {
    agents,
    organization,
    defaultAgentId,
    modelsByProvider,
    chatApiKeys,
    memberDefault,
    urlAgentId,
    canUseSavedAgent,
    isPermissionResolving,
    isOrgLoading,
    routeConversationId,
  } = params;

  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string>("");
  const [apiKeyId, setApiKeyId] = useState<string | null>(null);

  // Stores the resolved agent in a ref so the model init effect can read it
  // synchronously.
  const resolvedAgentRef = useRef<TAgent | null>(null);

  // Track which agentId URL param has been consumed (so we don't re-apply the
  // same one after the user clears the selection, but do apply a new one when
  // navigating from a different agent page).
  const urlParamsConsumedRef = useRef<string | null>(null);

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
    (agent: TAgent) => {
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

  // Resolve which agent to use on load.
  // Priority: URL param > org default > saved pick > member default > first.
  useEffect(() => {
    if (agents.length === 0) return;
    // Wait for organization data to avoid a race where agents load before org,
    // causing the org default to be skipped.
    if (isOrgLoading) return;

    // Process the URL agentId param, but only if it's a new value (not one we
    // already consumed). This allows navigating from different agent pages
    // while preventing re-application after the user manually changes the agent.
    if (urlAgentId && urlAgentId !== urlParamsConsumedRef.current) {
      const matchingAgent = agents.find((a) => a.id === urlAgentId);
      if (matchingAgent) {
        applyAgentSelection(matchingAgent);
        urlParamsConsumedRef.current = urlAgentId;
        return;
      }
    }

    // Org default always wins when set (admin-configured for the whole org).
    // localStorage only overrides when no org default is configured and the
    // user can change agents; otherwise a stale hidden picker value can trap
    // restricted users on a previously swapped agent.
    // Also skip if a URL param was consumed but state hasn't flushed yet.
    if (!agentId && !urlParamsConsumedRef.current) {
      if (isPermissionResolving) return;

      const selectedAgent = resolveInitialAgentSelection({
        agents,
        organizationDefaultAgentId: organization?.defaultAgentId,
        savedAgentId: getSavedAgent(),
        memberDefaultAgentId: defaultAgentId,
        canUseSavedAgent,
      });
      if (!selectedAgent) return;

      applyAgentSelection(selectedAgent);
      saveAgent(selectedAgent.id);
    }
  }, [
    applyAgentSelection,
    agentId,
    urlAgentId,
    agents,
    defaultAgentId,
    organization?.defaultAgentId,
    isOrgLoading,
    canUseSavedAgent,
    isPermissionResolving,
  ]);

  // Initialize model and API key once the agent is resolved (models may load
  // later). Uses modelInitializedRef instead of checking modelId to avoid a
  // race: ModelSelector's auto-select fires before this effect and sets modelId,
  // which would cause an early return and skip the proper priority chain.
  const modelInitializedRef = useRef(false);
  useEffect(() => {
    if (!agentId) return;
    if (modelInitializedRef.current) return;

    const resolved = resolveChatModelState({
      agent: resolvedAgentRef.current,
      modelsByProvider,
      chatApiKeys,
      organization: organizationDefaults,
      memberDefault: memberDefault ?? null,
    });

    if (!resolved) return; // No models available yet

    setModelId(resolved.modelId);
    if (resolved.apiKeyId) {
      setApiKeyId(resolved.apiKeyId);
    }
    modelInitializedRef.current = true;
  }, [
    agentId,
    modelsByProvider,
    chatApiKeys,
    organizationDefaults,
    memberDefault,
  ]);

  // Reset the resolved agent/model/key when leaving a conversation route for
  // the initial chat route (defined -> undefined) so the next new chat
  // re-resolves from scratch rather than inheriting the prior conversation's
  // selection.
  const previousRouteConversationIdRef = useRef<string | undefined>(
    routeConversationId,
  );
  useEffect(() => {
    const previousRouteConversationId = previousRouteConversationIdRef.current;
    previousRouteConversationIdRef.current = routeConversationId;

    if (
      shouldResetInitialChatState({
        previousRouteConversationId,
        routeConversationId,
      })
    ) {
      setAgentId(null);
      setModelId("");
      setApiKeyId(null);
      modelInitializedRef.current = false;
    }
  }, [routeConversationId]);

  // Persist the user's (model, key) pick as their member default so the next
  // new chat reuses it. No-ops on an incomplete pair.
  const updateMemberDefaultModelMutation = useUpdateMemberDefaultModel();
  const updateMemberDefaultModelMutateRef = useRef(
    updateMemberDefaultModelMutation.mutate,
  );
  updateMemberDefaultModelMutateRef.current =
    updateMemberDefaultModelMutation.mutate;
  const persistMemberDefaultModel = useCallback(
    (nextModelId: string | null, nextApiKeyId: string | null) => {
      if (!nextModelId || !nextApiKeyId) return;
      updateMemberDefaultModelMutateRef.current({
        modelId: nextModelId,
        chatApiKeyId: nextApiKeyId,
      });
    },
    [],
  );

  // Model change. The picked model is scoped to the selected key, so the pair
  // is persisted as the member default.
  const apiKeyIdRef = useRef(apiKeyId);
  apiKeyIdRef.current = apiKeyId;
  const onModelChange = useCallback(
    (nextModelId: string) => {
      setModelId(nextModelId);
      persistMemberDefaultModel(nextModelId, apiKeyIdRef.current);
    },
    [persistMemberDefaultModel],
  );

  // API key change — preselect the best model for the new key's provider.
  const onProviderChange = useCallback(
    (provider: SupportedProvider, nextApiKeyId: string) => {
      const preferred = resolvePreferredModelForProvider({
        provider,
        modelsByProvider,
      });
      if (preferred) {
        setModelId(preferred.modelId);
        persistMemberDefaultModel(preferred.modelId, nextApiKeyId);
      }
    },
    [modelsByProvider, persistMemberDefaultModel],
  );

  const onAgentChange = useCallback(
    (nextAgentId: string) => {
      const agent = agents.find((a) => a.id === nextAgentId);
      if (!agent) return;
      applyAgentSelection(agent);
      saveAgent(agent.id);
    },
    [agents, applyAgentSelection],
  );

  // Reset to the agent/org default model (shown when on a custom model).
  // Resolves without the member default — reset deliberately drops the user's
  // personal override to fall back to the agent/org default.
  const onResetModelOverride = useCallback(() => {
    modelInitializedRef.current = false;

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
    modelInitializedRef.current = true;

    // Clear the saved member default so the reset sticks for future new chats.
    updateMemberDefaultModelMutateRef.current({
      modelId: null,
      chatApiKeyId: null,
    });
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
    const agent = agents.find((a) => a.id === agentId);
    return deriveModelSource({
      selectedModelId: modelId,
      agentModelId: agent?.modelId,
      orgModelId: organization?.defaultModelId,
    });
  }, [modelId, agentId, agents, organization?.defaultModelId]);

  return {
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
  };
}
