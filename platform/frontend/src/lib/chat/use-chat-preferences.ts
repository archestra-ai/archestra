import {
  type archestraApiTypes,
  deriveModelSource as deriveModelSourceShared,
  type ModelSelection,
  type ModelSource,
  pickBestModel,
  providerRequiresPerUserCredential,
  type RankedModel,
  resolveModelSelection,
  type SupportedProvider,
} from "@archestra/shared";

export type { ModelSource };

/** The agent's resolved LLM config, as returned by the agents API. */
type AgentLlmConfig = archestraApiTypes.GetAllAgentsResponses["200"][number];

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
  /** A per-user provider (e.g. GitHub Copilot) catalogued for all members. */
  requiresUserConnection?: boolean;
  /** Whether the viewer has connected the per-user provider. */
  isConnected?: boolean;
}

/**
 * Determine whether the model selector should auto-select a different model.
 * Returns the model UUID to switch to, or null if no change is needed.
 *
 * Auto-selection only triggers when the selected model is genuinely
 * unavailable (e.g. the API key changed and the model is no longer offered).
 *
 * Prefers a ready-to-use model over a per-user-provider model the viewer hasn't
 * connected: the latter is catalogued org-wide and flagged "best", so without
 * this it would win the fallback over the viewer's own keyed models (mirrors the
 * ready-to-use fallback in `resolveInitialModel`). Falls back to the full list
 * when nothing is ready, so a connect-only org still gets a selection.
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
  const ready = availableModels.filter(
    (m) => !(m.requiresUserConnection && !m.isConnected),
  );
  const fallback = pickBestModel(ready.length > 0 ? ready : availableModels);
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

  const allModels = Object.values(modelsByProvider).flat();
  if (allModels.length === 0) {
    return null;
  }

  const providerForModel = (
    modelId: string | null | undefined,
  ): string | null => {
    if (!modelId) return null;
    return (
      Object.keys(modelsByProvider).find((provider) =>
        modelsByProvider[provider]?.some((m) => m.id === modelId),
      ) ?? null
    );
  };

  // A per-user provider (e.g. GitHub Copilot) is catalogued org-wide, but its
  // credential is the viewer's own and resolved at send time — the viewer holds
  // no key for it. So a per-user model is selectable by model alone: pairing it
  // with `findKeyForProvider` (null) would otherwise drop it from the catalog
  // and leave an org/agent default pointing at one half-pinned and skipped.
  const isPerUserModel = (modelId: string | null | undefined): boolean => {
    const provider = providerForModel(modelId);
    return (
      provider != null &&
      providerRequiresPerUserCredential(provider as SupportedProvider)
    );
  };

  // Flatten the catalog into RankedModel[], pairing each model with a key for
  // its provider so the shared resolver can attach an apiKeyId. Per-user models
  // have no viewer key and are intentionally excluded here: this list only
  // backs the "best available, ready-to-use" fallback, which should prefer a
  // keyed model over one the viewer would still have to connect. A configured
  // default pointing at a per-user model is handled by `toLevel` below.
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

  // Build the priority chain. A per-user level is completed with the placeholder
  // key so it wins by model alone (mirroring the backend, which honors a
  // resolved per-user model and then nulls the key) instead of being skipped as
  // half-pinned. The placeholder — and any real configured key, e.g. the admin's
  // on an org default — is dropped below.
  const toLevel = (
    modelId: string | null | undefined,
    apiKeyId: string | null | undefined,
  ): ModelSelection => ({
    modelId,
    apiKeyId: isPerUserModel(modelId) ? PER_USER_PLACEHOLDER_KEY : apiKeyId,
  });

  const levels: ModelSelection[] = [
    toLevel(memberDefault?.modelId, memberDefault?.chatApiKeyId),
    toLevel(agent?.modelId, agent?.llmApiKeyId),
    toLevel(organization?.defaultModelId, organization?.defaultLlmApiKeyId),
  ];

  const resolved = resolveModelSelection({ levels, availableModels });
  if (!resolved?.modelId) {
    // Catalog has models but none are linked to an accessible key — fall back
    // to the best model regardless of key.
    const best = pickBestModel(allModels);
    return best ? { modelId: best.id, apiKeyId: null } : null;
  }
  // A per-user provider model (e.g. an org default pointing at GitHub Copilot)
  // must not carry the configured key — that key belongs to whoever set it (the
  // admin) and isn't accessible to the viewer. Drop it so the selector resolves
  // the model on its own and the send falls through to per-user credential
  // resolution (which surfaces the inline connect prompt).
  return {
    modelId: resolved.modelId,
    apiKeyId: isPerUserModel(resolved.modelId)
      ? null
      : (resolved.apiKeyId ?? null),
  };
}

/**
 * Placeholder key paired with per-user-provider models inside
 * `resolveInitialModel` so they remain selectable even though the viewer holds
 * no real key for them. It is purely internal — never persisted or surfaced.
 */
const PER_USER_PLACEHOLDER_KEY = "__per_user_placeholder__";

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

// ===== Per-user-credential agent gating =====

/**
 * True when a (shared) agent pins a model from a per-user-credential provider
 * (e.g. GitHub Copilot) that the viewer hasn't connected: the agent's model is
 * the current selection but isn't in the viewer's available models. In that
 * case the chat keeps the agent's model selected instead of auto-swapping to a
 * fallback, so sending it surfaces an inline "connect your account" prompt.
 */
export function agentRequiresPerUserConnect(params: {
  agent:
    | Pick<AgentLlmConfig, "modelId" | "llmProviderRequiresPerUserCredential">
    | undefined;
  selectedModelId: string | null | undefined;
  isModelAvailable: boolean;
}): boolean {
  const { agent, selectedModelId, isModelAvailable } = params;
  if (!agent?.llmProviderRequiresPerUserCredential) return false;
  if (!selectedModelId || selectedModelId !== agent.modelId) return false;
  return !isModelAvailable;
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
