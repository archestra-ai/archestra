import {
  deriveModelSource as deriveModelSourceShared,
  type ModelSelection,
  type ModelSource,
  pickBestModel,
  type RankedModel,
  resolveModelSelection,
} from "@shared";

export type { ModelSource };

// ===== LocalStorage Keys =====

export const CHAT_STORAGE_KEYS = {
  selectedAgent: "selected-chat-agent",
} as const;

/** Read the saved agent ID from localStorage. */
export function getSavedAgent(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(CHAT_STORAGE_KEYS.selectedAgent);
  } catch {
    return null;
  }
}

/** Save the selected agent ID to localStorage. */
export function saveAgent(agentId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHAT_STORAGE_KEYS.selectedAgent, agentId);
  } catch {
    // QuotaExceededError or private browsing restriction
  }
}

// ===== Model auto-selection =====

interface AutoSelectableModel {
  /** The models.id UUID. */
  id: string;
  isBest?: boolean;
}

/**
 * Determine whether the model selector should auto-select a different model.
 * Returns the model UUID to switch to, or null if no change is needed.
 *
 * Auto-selection only triggers when the selected model is genuinely
 * unavailable (e.g. the API key changed and the model is no longer offered).
 */
export function resolveAutoSelectedModel(params: {
  selectedModel: string;
  availableModels: AutoSelectableModel[];
  isLoading: boolean;
}): string | null {
  const { selectedModel, availableModels, isLoading } = params;
  if (isLoading || availableModels.length === 0) return null;
  if (!selectedModel) return null;
  if (availableModels.some((m) => m.id === selectedModel)) return null;
  const fallback = pickBestModel(availableModels);
  return fallback && fallback.id !== selectedModel ? fallback.id : null;
}

// ===== Model resolution =====

interface ModelInfo {
  /** The models.id UUID. */
  id: string;
  isBest?: boolean;
}

interface AgentInfo {
  modelId?: string | null;
  llmApiKeyId?: string | null;
}

interface OrganizationInfo {
  defaultModelId?: string | null;
  defaultLlmApiKeyId?: string | null;
}

/** The current user's saved default (model, key) pair — the "member" level. */
interface MemberDefaultInfo {
  modelId?: string | null;
  chatApiKeyId?: string | null;
}

interface ChatContext {
  modelsByProvider: Record<string, ModelInfo[]>;
  chatApiKeys: Array<{ id: string; provider: string }>;
  organization: OrganizationInfo | null;
  memberDefault: MemberDefaultInfo | null;
}

interface ResolveInitialModelParams extends ChatContext {
  agent: AgentInfo | null;
}

interface ResolvedModel {
  modelId: string;
  apiKeyId: string | null;
}

/**
 * Resolve which model to use on initial chat load.
 * Priority: member default -> agent default -> organization default ->
 * best available model. Returns null when no model can be resolved.
 *
 * Delegates to the shared `resolveModelSelection` so the client and the
 * server resolve identically.
 */
export function resolveInitialModel(
  params: ResolveInitialModelParams,
): ResolvedModel | null {
  const { modelsByProvider, agent, chatApiKeys, organization, memberDefault } =
    params;

  const findKeyForProvider = (provider: string): string | null =>
    chatApiKeys.find((k) => k.provider === provider)?.id ?? null;

  if (Object.values(modelsByProvider).flat().length === 0) {
    return null;
  }

  // Flatten the catalog into RankedModel[], pairing each model with a key for
  // its provider so the shared resolver can attach an apiKeyId.
  const availableModels: RankedModel[] = [];
  for (const [provider, models] of Object.entries(modelsByProvider)) {
    const apiKeyId = findKeyForProvider(provider);
    if (!apiKeyId) {
      continue;
    }
    for (const m of models) {
      availableModels.push({ modelId: m.id, apiKeyId, isBest: m.isBest });
    }
  }

  const levels: ModelSelection[] = [
    {
      modelId: memberDefault?.modelId,
      apiKeyId: memberDefault?.chatApiKeyId,
    },
    { modelId: agent?.modelId, apiKeyId: agent?.llmApiKeyId },
    {
      modelId: organization?.defaultModelId,
      apiKeyId: organization?.defaultLlmApiKeyId,
    },
  ];

  const resolved = resolveModelSelection({ levels, availableModels });
  if (!resolved?.modelId) {
    // Catalog has models but none are linked to an accessible key — fall back
    // to the best model regardless of key.
    const allModels = Object.values(modelsByProvider).flat();
    const best = pickBestModel(allModels);
    return best ? { modelId: best.id, apiKeyId: null } : null;
  }
  return { modelId: resolved.modelId, apiKeyId: resolved.apiKeyId ?? null };
}

/**
 * Resolve the model and API key to use when switching to a given agent.
 * Applies the same priority chain as initial load.
 */
export function resolveModelForAgent(params: {
  agent: AgentInfo;
  context: ChatContext;
}): ResolvedModel | null {
  return resolveInitialModel({ ...params.context, agent: params.agent });
}

// ===== Model source =====

/**
 * Determine where the selected model came from, by comparison with the
 * configured defaults. See the shared `deriveModelSource`.
 */
export function deriveModelSource(params: {
  selectedModelId: string | null | undefined;
  agentModelId: string | null | undefined;
  orgModelId: string | null | undefined;
}): ModelSource | null {
  return deriveModelSourceShared(params);
}
