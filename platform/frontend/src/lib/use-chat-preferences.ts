// ===== LocalStorage Keys =====

export const CHAT_STORAGE_KEYS = {
  selectedModel: "archestra-chat-selected-chat-model",
  selectedAgent: "selected-chat-agent",
  selectedApiKeyPrefix: "selected-chat-api-key-id",
} as const;

// ===== Pure functions (testable without React) =====

/**
 * Get the localStorage key for a provider-specific API key selection.
 */
export function getApiKeyStorageKey(provider: string): string {
  return `${CHAT_STORAGE_KEYS.selectedApiKeyPrefix}-${provider}`;
}

/**
 * Read the saved model ID from localStorage.
 * Returns null if not set or if running on the server.
 */
export function getSavedModel(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(CHAT_STORAGE_KEYS.selectedModel);
  } catch {
    return null;
  }
}

/**
 * Save the selected model ID to localStorage.
 */
export function saveModel(modelId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHAT_STORAGE_KEYS.selectedModel, modelId);
  } catch {
    // QuotaExceededError or private browsing restriction
  }
}

/**
 * Clear the saved model from localStorage (e.g., when it becomes stale).
 */
export function clearSavedModel(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CHAT_STORAGE_KEYS.selectedModel);
  } catch {
    // QuotaExceededError or private browsing restriction
  }
}

/**
 * Read the saved agent ID from localStorage.
 */
export function getSavedAgent(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(CHAT_STORAGE_KEYS.selectedAgent);
  } catch {
    return null;
  }
}

/**
 * Save the selected agent ID to localStorage.
 */
export function saveAgent(agentId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHAT_STORAGE_KEYS.selectedAgent, agentId);
  } catch {
    // QuotaExceededError or private browsing restriction
  }
}

/**
 * Read the saved API key ID for a specific provider from localStorage.
 */
export function getSavedApiKey(provider: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(getApiKeyStorageKey(provider));
  } catch {
    return null;
  }
}

/**
 * Save the selected API key ID for a specific provider to localStorage.
 */
export function saveApiKey(provider: string, keyId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getApiKeyStorageKey(provider), keyId);
  } catch {
    // QuotaExceededError or private browsing restriction
  }
}

// ===== Model auto-selection logic =====

interface AutoSelectableModel {
  id: string;
  isBest?: boolean;
}

interface ResolveAutoSelectParams {
  selectedModel: string;
  availableModels: AutoSelectableModel[];
  isLoading: boolean;
}

/**
 * Determine whether the model selector should auto-select a different model.
 * Returns the model ID to switch to, or null if no change is needed.
 *
 * Auto-selection only triggers when the selected model is genuinely unavailable
 * (e.g., the API key changed and the model isn't offered by the new provider).
 * It does NOT trigger just because the API key changed — this prevents a race
 * condition during initialization where the null→keyId transition was
 * incorrectly treated as a "key change" and overwrote the user's saved model.
 */
export function resolveAutoSelectedModel(
  params: ResolveAutoSelectParams,
): string | null {
  const { selectedModel, availableModels, isLoading } = params;

  // Not ready yet — wait for models to load
  if (isLoading || availableModels.length === 0) return null;

  // Parent hasn't resolved the model yet (empty string during init)
  if (!selectedModel) return null;

  // Current model is available — no change needed
  if (availableModels.some((m) => m.id === selectedModel)) return null;

  // Model is unavailable — pick the best or first available
  const best = availableModels.find((m) => m.isBest);
  const fallback = best ?? availableModels[0];

  // Only return a change if it's actually different
  return fallback && fallback.id !== selectedModel ? fallback.id : null;
}

// ===== Model resolution logic =====

interface ModelInfo {
  id: string;
}

interface AgentInfo {
  llmModel?: string | null;
  llmApiKeyId?: string | null;
}

interface ResolveInitialModelParams {
  modelsByProvider: Record<string, ModelInfo[]>;
  agent: AgentInfo | null;
  chatApiKeys: Array<{ id: string; provider: string }>;
}

interface ResolvedModel {
  modelId: string;
  apiKeyId: string | null;
  source: "localStorage" | "agent" | "fallback";
}

/**
 * Resolve which model to use on initial chat load.
 * Priority: localStorage > agent config > first available model.
 * Returns null if no model can be resolved (e.g., no models available).
 */
export function resolveInitialModel(
  params: ResolveInitialModelParams,
): ResolvedModel | null {
  const { modelsByProvider, agent, chatApiKeys } = params;
  const allModels = Object.values(modelsByProvider).flat();
  if (allModels.length === 0) return null;

  const findKeyForProvider = (provider: string): string | null => {
    const key = chatApiKeys.find((k) => k.provider === provider);
    return key?.id ?? null;
  };

  const findProviderForModel = (modelId: string): string | null => {
    for (const [provider, models] of Object.entries(modelsByProvider)) {
      if (models.some((m) => m.id === modelId)) return provider;
    }
    return null;
  };

  // 1. User's explicit selection from localStorage
  const savedModelId = getSavedModel();
  if (savedModelId && allModels.some((m) => m.id === savedModelId)) {
    const provider = findProviderForModel(savedModelId);
    return {
      modelId: savedModelId,
      apiKeyId: provider ? findKeyForProvider(provider) : null,
      source: "localStorage",
    };
  }

  // Clear stale localStorage value if it existed but model no longer available
  if (savedModelId) {
    clearSavedModel();
  }

  // 2. Agent-configured model
  if (agent?.llmModel && allModels.some((m) => m.id === agent.llmModel)) {
    return {
      modelId: agent.llmModel,
      apiKeyId: agent.llmApiKeyId ?? null,
      source: "agent",
    };
  }

  // 3. First available model
  const providers = Object.keys(modelsByProvider);
  if (providers.length > 0) {
    const firstProvider = providers[0];
    const models = modelsByProvider[firstProvider];
    if (models && models.length > 0) {
      return {
        modelId: models[0].id,
        apiKeyId: findKeyForProvider(firstProvider),
        source: "fallback",
      };
    }
  }

  return null;
}
