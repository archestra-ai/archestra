"use client";

import {
  compareModelsForDisplay,
  modelSupportsThinkingEffort,
  providerSupportsChat,
  type SupportedProvider,
  type ThinkingEffortSetting,
} from "@archestra/shared";
import { useEffect, useMemo } from "react";
import {
  filterAndSortInitialAgents,
  groupInitialAgents,
} from "@/components/chat/initial-agent-selector.utils";
import {
  useAgentCredentialReadiness,
  useChatAgents,
  usePinnedAgentIds,
  useProfile,
} from "@/lib/agent.query";
import { useSession } from "@/lib/auth/auth.query";
import {
  type AgentConnectionGate,
  indexReadinessByAgent,
  resolveAgentConnectionGate,
} from "@/lib/chat/agent-connection-gate";
import { useUpdateConversation } from "@/lib/chat/chat.query";
import { resolveAutoSelectedModel } from "@/lib/chat/use-chat-preferences";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import { useLlmModels } from "@/lib/llm-models.query";
import {
  type LlmProviderApiKey,
  useAvailableLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";

export type ChatSetupAgent = NonNullable<
  ReturnType<typeof useChatAgents>["data"]
>[number];

export const REASONING_OPTIONS: {
  value: ThinkingEffortSetting;
  label: string;
  hint: string;
}[] = [
  {
    value: null,
    label: "Auto",
    hint: "Let the model reason as it normally would",
  },
  {
    value: "low",
    label: "Low",
    hint: "As little reasoning as the model allows",
  },
  {
    value: "medium",
    label: "Med",
    hint: "Some reasoning before answering",
  },
  { value: "high", label: "High", hint: "Reason as deeply as the model can" },
];

/**
 * Lists and actions behind the composer's setup menu. Selection semantics
 * match the standalone pickers: agents grouped like the agent picker, models
 * per provider in display order, chat-capable keys minus other users'
 * personal subscriptions, and conversation key changes routed through
 * `onProviderChange` so the key and model update together.
 */
export function useChatSetupOptions(params: {
  conversationId?: string;
  agentId: string | null | undefined;
  onAgentChange?: (agentId: string) => void;
  selectedModel: string;
  onModelChange: (dbId: string) => void;
  fallbackModelName?: string;
  /** Keep a pinned per-user model selected instead of auto-switching away. */
  suppressAutoSelect: boolean;
  apiKeyId: string | null;
  currentProvider?: SupportedProvider;
  onApiKeyChange?: (apiKeyId: string) => void;
  onProviderChange?: (provider: SupportedProvider, apiKeyId: string) => void;
  onThinkingEffortChange?: (effort: ThinkingEffortSetting) => void;
}) {
  const catalog = useModelProviderCatalog();
  const { data: session } = useSession();
  const userId = session?.user?.id;

  // ---- agents
  const { data: roster = [] } = useChatAgents();
  const { data: pinnedIds } = usePinnedAgentIds();
  const { data: readiness } = useAgentCredentialReadiness({
    enabled: !!params.onAgentChange,
  });
  const readinessByAgent = useMemo(
    () => indexReadinessByAgent(readiness),
    [readiness],
  );
  const activeAgent =
    roster.find((a) => a.id === params.agentId) ??
    roster.find((a) => !a.builtIn && a.scope === "personal") ??
    roster.find((a) => !a.builtIn);
  const { data: agentDetail } = useProfile(activeAgent?.id);
  const agentGroups = useMemo(
    () =>
      groupInitialAgents({
        agents: filterAndSortInitialAgents({
          allAgents: roster,
          currentAgentId: params.agentId ?? null,
          search: "",
          userId,
        }),
        userId,
        pinnedIds: pinnedIds ?? [],
      }),
    [roster, params.agentId, userId, pinnedIds],
  );
  // Only the hydrated profile knows the agent's tools; never guess from the
  // roster, which omits them.
  const agentToolsSummary =
    agentDetail && agentDetail.id === activeAgent?.id
      ? agentDetail.accessAllTools
        ? "All tools"
        : toolServerCount(agentDetail.tools)
      : null;
  const agentGate = (agentId: string): AgentConnectionGate =>
    resolveAgentConnectionGate(readinessByAgent.get(agentId));

  // ---- models
  const {
    data: models = [],
    isLoading: modelsLoading,
    isPlaceholderData,
  } = useLlmModels({ apiKeyId: params.apiKeyId ?? undefined });
  const activeModel = models.find((m) => m.dbId === params.selectedModel);
  const modelSections = useMemo(
    () =>
      groupByProvider({
        items: models,
        currentProvider: params.currentProvider,
        label: catalog.label,
      }).map(({ provider, label, items }) => ({
        provider,
        label,
        models: [...items].sort((a, b) =>
          compareModelsForDisplay(
            { modelId: a.id, isBest: a.isBest },
            { modelId: b.id, isBest: b.isBest },
          ),
        ),
      })),
    [models, catalog, params.currentProvider],
  );

  // Same guard as the model picker: when the key changes and the selected
  // model is no longer offered, fall back to the best available one.
  const { selectedModel, onModelChange, suppressAutoSelect } = params;
  useEffect(() => {
    if (isPlaceholderData || suppressAutoSelect) return;
    const next = resolveAutoSelectedModel({
      selectedModel,
      availableModels: models.map((m) => ({
        id: m.dbId,
        isBest: m.isBest,
        requiresUserConnection: m.requiresUserConnection,
        isConnected: m.isConnected,
      })),
      isLoading: modelsLoading,
    });
    if (next) onModelChange(next);
  }, [
    isPlaceholderData,
    suppressAutoSelect,
    selectedModel,
    models,
    modelsLoading,
    onModelChange,
  ]);

  // ---- credentials
  const { data: allKeys = [] } = useAvailableLlmProviderApiKeys({
    includeKeyId: params.apiKeyId ?? undefined,
    toastOnError: false,
  });
  const keys = useMemo(
    () =>
      allKeys.filter(
        (k) =>
          providerSupportsChat(k.provider) &&
          !catalog.isHidden(k.provider) &&
          (!isPersonalSubscription(k) || k.userId === userId),
      ),
    [allKeys, catalog, userId],
  );
  const keySections = useMemo(
    () =>
      groupByProvider({
        items: keys,
        currentProvider: params.currentProvider,
        label: catalog.label,
      }).map(({ provider, label, items }) => ({
        provider,
        label,
        keys: items,
      })),
    [keys, catalog, params.currentProvider],
  );

  // ---- reasoning
  const supportsReasoning =
    !!activeModel &&
    !!params.onThinkingEffortChange &&
    modelSupportsThinkingEffort({
      provider: activeModel.provider,
      modelId: activeModel.id,
      supportsReasoningEffort:
        activeModel.capabilities?.supportsReasoningEffort,
    });

  // ---- actions
  const updateConversation = useUpdateConversation();
  const selectKey = (key: LlmProviderApiKey) => {
    if (key.id === params.apiKeyId) return;
    if (params.conversationId) {
      if (params.onProviderChange) {
        params.onProviderChange(key.provider, key.id);
      } else {
        updateConversation.mutate({
          id: params.conversationId,
          chatApiKeyId: key.id,
        });
      }
      return;
    }
    params.onApiKeyChange?.(key.id);
    params.onProviderChange?.(key.provider, key.id);
  };

  return {
    providerLabel: catalog.label,
    // agents
    activeAgent,
    agentName: agentDetail?.name ?? activeAgent?.name ?? "Choose an agent",
    agentIcon: agentDetail?.icon ?? activeAgent?.icon ?? null,
    agentToolsSummary,
    agentGroups,
    agentGate,
    selectAgent: (id: string) => {
      if (id !== params.agentId) params.onAgentChange?.(id);
    },
    // models
    modelsLoading,
    activeModel,
    modelName:
      activeModel?.displayName ?? params.fallbackModelName ?? "Choose a model",
    modelSections,
    selectModel: (dbId: string) => {
      if (dbId !== params.selectedModel) params.onModelChange(dbId);
    },
    // credentials
    keys,
    activeKey: keys.find((k) => k.id === params.apiKeyId),
    keySections,
    keyScopeLabel,
    selectKey,
    // reasoning
    supportsReasoning,
  };
}


// ============================================================================

function keyScopeLabel(key: LlmProviderApiKey) {
  if (isPersonalSubscription(key)) return "Your subscription";
  if (key.scope === "personal") return "Personal key";
  if (key.scope === "team") return key.teamName ?? "Team key";
  return "Organization key";
}

function toolServerCount(tools: { catalogId: string | null }[] | undefined) {
  const count = new Set(tools?.map((tool) => tool.catalogId)).size;
  if (count === 0) return "No tools";
  return `${count} tool server${count === 1 ? "" : "s"}`;
}

function groupByProvider<T extends { provider: SupportedProvider }>(params: {
  items: T[];
  currentProvider?: SupportedProvider;
  label: (provider: SupportedProvider) => string;
}) {
  const { items, currentProvider, label } = params;
  const byProvider = new Map<SupportedProvider, T[]>();
  for (const item of items) {
    const list = byProvider.get(item.provider) ?? [];
    list.push(item);
    byProvider.set(item.provider, list);
  }
  return [...byProvider.entries()]
    .map(([provider, grouped]) => ({
      provider,
      label: label(provider),
      items: grouped,
    }))
    .sort((a, b) => {
      if (a.provider === currentProvider) return -1;
      if (b.provider === currentProvider) return 1;
      return a.label.localeCompare(b.label);
    });
}
