import type { ThinkingEffortSetting } from "@archestra/shared";
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
  resolveAgent?: (id: string) => TAgent | undefined;
  isAgentsLoading?: boolean;
  organization: InitialChatOrganization;
  defaultAgentId: string | null | undefined;
  modelsByProvider: Record<string, LlmModel[]>;
  /** Keys the viewer may use (the available-keys list), not merely see. */
  chatApiKeys: { id: string; provider: string }[];
  memberDefault: InitialChatMemberDefault;
  // ---- caller-owned policy, kept explicit at the boundary ----
  /** Resolve to this agent if it is present (page passes the URL param). */
  urlAgentId?: string | null;
  /** A model chosen by a launcher before navigating to a new chat. */
  urlModelId?: string | null;
  /**
   * The pinned agent of the project this chat is being started in, when there
   * is one. Outranks the org default.
   */
  projectDefaultAgentId?: string | null;
  /** Honor the localStorage saved-agent step (page gates this on RBAC). */
  canUseSavedAgent: boolean;
  /** Hold resolution until the caller's permission flags settle. */
  isPermissionResolving: boolean;
  /** Hold resolution until the organization data is available. */
  isOrgLoading: boolean;
  /**
   * Hold resolution until the project data is available. Resolution runs once,
   * so without this a chat started in a project settles on the org default
   * before its pin arrives and never re-resolves.
   */
  isProjectLoading?: boolean;
  /**
   * Hold resolution until the usable keys are loaded. Resolution runs once,
   * so resolving against an empty list would settle on a model with no key.
   */
  isApiKeysLoading?: boolean;
  /**
   * The conversation id from the route, if any. When it transitions from a
   * conversation to the initial chat route (defined -> undefined), the resolved
   * agent/model/key are reset so a fresh new chat re-resolves from scratch.
   */
  routeConversationId?: string;
};

export type InitialChatModelState = {
  agentId: string | null;
  /**
   * No agent yet, but one is still being decided (data loading, or the
   * resolution effect has not run). Pickers show a placeholder meanwhile.
   */
  isAgentResolving: boolean;
  modelId: string;
  apiKeyId: string | null;
  provider: SupportedProvider | undefined;
  modelSource: ModelSource | null;
  setApiKeyId: (apiKeyId: string | null) => void;
  thinkingEffort: ThinkingEffortSetting;
  setThinkingEffort: (effort: ThinkingEffortSetting) => void;
  onAgentChange: (agentId: string) => void;
  onModelChange: (modelId: string) => void;
  onProviderChange: (provider: SupportedProvider, apiKeyId: string) => void;
  onResetModelOverride: () => void;
};

/**
 * The shared new-chat initialization orchestration: the agent/model/key
 * resolution chain (project default > org default > saved pick > member default
 * > first), the resolution effects, member-default persistence, and the change
 * handlers.
 *
 * It does NO data fetching — every query result is passed in so query policy
 * (which queries run and when they are enabled) stays at the caller boundary.
 * Both the /chat page and the project handoff composer consume it.
 */
export function useInitialChatModelState<TAgent extends InitialChatAgent>(
  params: InitialChatModelStateParams<TAgent>,
): InitialChatModelState & { selectedAgent: TAgent | null } {
  const {
    agents,
    resolveAgent,
    isAgentsLoading,
    organization,
    defaultAgentId,
    modelsByProvider,
    chatApiKeys,
    memberDefault,
    urlAgentId,
    urlModelId,
    projectDefaultAgentId,
    canUseSavedAgent,
    isPermissionResolving,
    isOrgLoading,
    isProjectLoading,
    isApiKeysLoading,
    routeConversationId,
  } = params;

  // With the data already in the cache on the first render (a page the
  // server rendered with the composer's data), the starting agent and model
  // resolve in that render, so the server and the browser draw the final
  // composer at once. Only a choice that this browser's saved pick cannot
  // change resolves here; the effect below resolves the rest as before.
  const [initial] = useState(() => resolveOnFirstRender(params));
  const [agentId, setAgentId] = useState<string | null>(
    initial?.agent.id ?? null,
  );
  const [selectedAgent, setSelectedAgent] = useState<TAgent | null>(
    initial?.agent ?? null,
  );
  // Whether the load-time resolution below has run to a decision. Until it
  // has, the agent picker must not guess: a guess paints one agent and then
  // swaps to the resolved one. A first-render choice is that decision.
  const [hasResolvedAgent, setHasResolvedAgent] = useState(!!initial);
  const [modelId, setModelId] = useState<string>(initial?.model?.modelId ?? "");
  const [apiKeyId, setApiKeyId] = useState<string | null>(
    initial?.model?.apiKeyId ?? null,
  );
  // Carried into the create request on first submit, so a choice made before
  // the conversation exists survives into the row.
  const [thinkingEffort, setThinkingEffort] =
    useState<ThinkingEffortSetting>(null);

  // Stores the resolved agent in a ref so the model init effect can read it
  // synchronously.
  const resolvedAgentRef = useRef<TAgent | null>(initial?.agent ?? null);

  // Track which agentId URL param has been consumed (so we don't re-apply the
  // same one after the user clears the selection, but do apply a new one when
  // navigating from a different agent page).
  const urlParamsConsumedRef = useRef<string | null>(
    initial?.fromUrl ? (urlAgentId ?? null) : null,
  );

  // A first-render choice is saved as the effect's choice would be.
  useEffect(() => {
    if (initial && !initial.fromUrl && !initial.fromProjectDefault) {
      saveAgent(initial.agent.id);
    }
  }, [initial]);

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
      setSelectedAgent(agent);
      resolvedAgentRef.current = agent;

      const resolved = resolveInitialAgentState({
        agent,
        modelsByProvider,
        chatApiKeys,
        organization: organizationDefaults,
        memberDefault: memberDefault ?? null,
      });

      const chosen =
        resolveUrlModelSelection({
          urlModelId,
          modelsByProvider,
          chatApiKeys,
        }) ?? resolved;
      if (chosen) {
        setModelId(chosen.modelId);
        setApiKeyId(chosen.apiKeyId);
      } else {
        setModelId("");
        setApiKeyId(null);
      }
    },
    [
      modelsByProvider,
      chatApiKeys,
      organizationDefaults,
      memberDefault,
      urlModelId,
    ],
  );

  // Resolve which agent to use on load.
  // Priority: URL param > project pin > personal default > org default >
  // saved pick > first.
  useEffect(() => {
    if (isAgentsLoading || agents.length === 0) return;
    // Wait for organization data to avoid a race where agents load before org,
    // causing the org default to be skipped.
    if (isOrgLoading) return;
    // Same race for a chat started in a project: this effect resolves once, so
    // a pin that lands afterwards would never be applied.
    if (isProjectLoading) return;
    if (isApiKeysLoading) return;

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

    // The member's personal default wins, then the org default (admin-
    // configured for the whole org). The personal default is only ever set
    // deliberately, so it is absent for members who never picked one and the
    // org default reaches them. localStorage only overrides when neither is
    // configured and the user can change agents; otherwise a stale hidden
    // picker value can trap restricted users on a previously selected agent.
    // Also skip if a URL param was consumed but state hasn't flushed yet.
    if (!agentId && !urlParamsConsumedRef.current) {
      if (isPermissionResolving) return;

      const selection = resolveInitialAgentSelection({
        agents,
        projectDefaultAgentId,
        organizationDefaultAgentId: organization?.defaultAgentId,
        savedAgentId: getSavedAgent(),
        memberDefaultAgentId: defaultAgentId,
        canUseSavedAgent,
      });
      setHasResolvedAgent(true);
      if (!selection) return;

      applyAgentSelection(selection.agent);
      // The saved-agent store is global, not per-project, so persisting a
      // project's pin here would carry it into unrelated chats afterwards. A
      // manual pick still saves (see onAgentChange).
      if (!selection.fromProjectDefault) {
        saveAgent(selection.agent.id);
      }
    }
  }, [
    applyAgentSelection,
    agentId,
    urlAgentId,
    agents,
    isAgentsLoading,
    defaultAgentId,
    projectDefaultAgentId,
    organization?.defaultAgentId,
    isOrgLoading,
    isProjectLoading,
    isApiKeysLoading,
    canUseSavedAgent,
    isPermissionResolving,
  ]);

  // Initialize model and API key once the agent is resolved (models may load
  // later). Uses modelInitializedRef instead of checking modelId to avoid a
  // race: ModelSelector's auto-select fires before this effect and sets modelId,
  // which would cause an early return and skip the proper priority chain.
  const modelInitializedRef = useRef(!!initial?.model);
  useEffect(() => {
    if (!agentId) return;
    if (modelInitializedRef.current) return;
    if (isApiKeysLoading) return;

    const resolved = resolveChatModelState({
      agent: resolvedAgentRef.current,
      modelsByProvider,
      chatApiKeys,
      organization: organizationDefaults,
      memberDefault: memberDefault ?? null,
    });

    if (!resolved) return; // No models available yet

    const chosen =
      resolveUrlModelSelection({ urlModelId, modelsByProvider, chatApiKeys }) ??
      resolved;
    setModelId(chosen.modelId);
    if (chosen.apiKeyId) {
      setApiKeyId(chosen.apiKeyId);
    }
    modelInitializedRef.current = true;
  }, [
    agentId,
    modelsByProvider,
    chatApiKeys,
    organizationDefaults,
    memberDefault,
    urlModelId,
    isApiKeysLoading,
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
      setSelectedAgent(null);
      setHasResolvedAgent(false);
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
  const chatApiKeysRef = useRef(chatApiKeys);
  chatApiKeysRef.current = chatApiKeys;
  const persistMemberDefaultModel = useCallback(
    (nextModelId: string | null, nextApiKeyId: string | null) => {
      if (!nextModelId || !nextApiKeyId) return;
      // A default carries into chats on any agent, so it must be a key the
      // viewer may use; an agent's own key works only through that agent.
      if (!chatApiKeysRef.current.some((k) => k.id === nextApiKeyId)) return;
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
      const agent =
        agents.find((a) => a.id === nextAgentId) ?? resolveAgent?.(nextAgentId);
      if (!agent) return;
      applyAgentSelection(agent);
      saveAgent(agent.id);
    },
    [agents, applyAgentSelection, resolveAgent],
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
    const agent = agents.find((a) => a.id === agentId) ?? selectedAgent;
    return deriveModelSource({
      selectedModelId: modelId,
      agentModelId: agent?.modelId,
      orgModelId: organization?.defaultModelId,
    });
  }, [modelId, agentId, agents, selectedAgent, organization?.defaultModelId]);

  return {
    selectedAgent,
    agentId,
    isAgentResolving:
      !agentId &&
      !hasResolvedAgent &&
      (isAgentsLoading === true || agents.length > 0),
    modelId,
    apiKeyId,
    provider,
    modelSource,
    setApiKeyId,
    thinkingEffort,
    setThinkingEffort,
    onAgentChange,
    onModelChange,
    onProviderChange,
    onResetModelOverride,
  };
}

function resolveUrlModelSelection(params: {
  urlModelId?: string | null;
  modelsByProvider: Record<string, LlmModel[]>;
  chatApiKeys: { id: string; provider: string }[];
}) {
  if (!params.urlModelId) return null;
  const model = Object.values(params.modelsByProvider)
    .flat()
    .find((entry) => entry.dbId === params.urlModelId);
  if (!model) return null;
  const key = params.chatApiKeys.find(
    (entry) => entry.provider === model.provider,
  );
  if (!key) return null;
  return { modelId: model.dbId, apiKeyId: key.id };
}

/**
 * The starting agent and model, when the first render already has what the
 * load effect waits for and the outcome cannot depend on this browser's saved
 * pick. Null otherwise: the effect then resolves as it always has. The saved
 * pick lives in localStorage, which the server cannot read, so resolving it
 * here would render a different composer on the server and in the browser.
 */
function resolveOnFirstRender<TAgent extends InitialChatAgent>(
  params: InitialChatModelStateParams<TAgent>,
): {
  agent: TAgent;
  model: { modelId: string; apiKeyId: string | null } | null;
  fromUrl: boolean;
  fromProjectDefault: boolean;
} | null {
  if (
    params.isAgentsLoading ||
    params.agents.length === 0 ||
    params.isOrgLoading ||
    params.isProjectLoading ||
    params.isApiKeysLoading ||
    params.isPermissionResolving
  ) {
    return null;
  }
  let agent: TAgent | undefined;
  let fromProjectDefault = false;
  const fromUrl = !!params.urlAgentId;
  if (params.urlAgentId) {
    agent = params.agents.find((a) => a.id === params.urlAgentId);
  } else {
    const selection = resolveInitialAgentSelection({
      agents: params.agents,
      projectDefaultAgentId: params.projectDefaultAgentId,
      organizationDefaultAgentId: params.organization?.defaultAgentId,
      savedAgentId: null,
      memberDefaultAgentId: params.defaultAgentId,
      canUseSavedAgent: false,
    });
    // A default (project, member or organization) outranks a saved pick, so
    // its choice holds whatever this browser saved; the fallback can be drawn
    // only where no saved pick could outrank it.
    if (
      selection &&
      (selection.source !== "fallback" || !params.canUseSavedAgent)
    ) {
      agent = selection.agent;
      fromProjectDefault = selection.fromProjectDefault;
    }
  }
  if (!agent) return null;
  const resolved = resolveInitialAgentState({
    agent,
    modelsByProvider: params.modelsByProvider,
    chatApiKeys: params.chatApiKeys,
    organization: params.organization
      ? {
          defaultModelId: params.organization.defaultModelId,
          defaultLlmApiKeyId: params.organization.defaultLlmApiKeyId,
        }
      : null,
    memberDefault: params.memberDefault ?? null,
  });
  const model =
    resolveUrlModelSelection({
      urlModelId: params.urlModelId,
      modelsByProvider: params.modelsByProvider,
      chatApiKeys: params.chatApiKeys,
    }) ?? resolved;
  return {
    agent,
    model: model ? { modelId: model.modelId, apiKeyId: model.apiKeyId } : null,
    fromUrl,
    fromProjectDefault,
  };
}
