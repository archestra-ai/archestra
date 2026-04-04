// ===== LocalStorage Keys =====

export const CHAT_STORAGE_KEYS = {
  selectedAgent: "selected-chat-agent",
  userModelOverride: "chat-user-model-override",
} as const;

// ===== Pure functions (testable without React) =====

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
 * Read the user's model override from localStorage.
 */
export function getSavedModelOverride(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(CHAT_STORAGE_KEYS.userModelOverride);
  } catch {
    return null;
  }
}

/**
 * Save the user's model override to localStorage.
 */
export function saveModelOverride(modelId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHAT_STORAGE_KEYS.userModelOverride, modelId);
  } catch {
    // QuotaExceededError or private browsing restriction
  }
}

/**
 * Clear the user's model override from localStorage.
 */
export function clearModelOverride(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CHAT_STORAGE_KEYS.userModelOverride);
  } catch {
    // ignore
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

interface OrganizationInfo {
  defaultLlmModel?: string | null;
  defaultLlmApiKeyId?: string | null;
}

interface ChatContext {
  modelsByProvider: Record<string, ModelInfo[]>;
  chatApiKeys: Array<{ id: string; provider: string }>;
  organization: OrganizationInfo | null;
}

interface ResolveInitialModelParams extends ChatContext {
  agent: AgentInfo | null;
}

export type ModelSource = "agent" | "organization" | "user" | "fallback";

interface ResolvedModel {
  modelId: string;
  apiKeyId: string | null;
  source: ModelSource;
}

/**
 * Resolve which model to use on initial chat load.
 * Priority: user override > agent config > organization default > first available model.
 * Returns null if no model can be resolved (e.g., no models available).
 */
export function resolveInitialModel(
  params: ResolveInitialModelParams,
): ResolvedModel | null {
  const { modelsByProvider, agent, chatApiKeys, organization } = params;
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

  // 0. User override from localStorage
  const userOverride = getSavedModelOverride();
  if (userOverride && allModels.some((m) => m.id === userOverride)) {
    const provider = findProviderForModel(userOverride);
    return {
      modelId: userOverride,
      apiKeyId: provider ? findKeyForProvider(provider) : null,
      source: "user",
    };
  }

  // 1. Agent-configured model
  if (agent?.llmModel && allModels.some((m) => m.id === agent.llmModel)) {
    return {
      modelId: agent.llmModel,
      apiKeyId: agent.llmApiKeyId ?? null,
      source: "agent",
    };
  }

  // 2. Organization default model
  if (
    organization?.defaultLlmModel &&
    allModels.some((m) => m.id === organization.defaultLlmModel)
  ) {
    const provider = findProviderForModel(organization.defaultLlmModel);
    const orgKeyId = organization.defaultLlmApiKeyId ?? null;
    const orgKeyAvailable =
      orgKeyId && chatApiKeys.some((k) => k.id === orgKeyId);
    const apiKeyId = orgKeyAvailable
      ? orgKeyId
      : provider
        ? findKeyForProvider(provider)
        : null;
    return {
      modelId: organization.defaultLlmModel,
      apiKeyId,
      source: "organization",
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

// ===== Agent switch helper =====

/**
 * Resolve the model and API key to use when switching to a given agent.
 * Delegates to resolveInitialModel with the agent's LLM config.
 *
 * This ensures the same priority chain (agent config → org default → fallback)
 * is applied both on initial load and when the user switches agents.
 */
export function resolveModelForAgent(params: {
  agent: AgentInfo;
  context: ChatContext;
}): ResolvedModel | null {
  return resolveInitialModel({
    ...params.context,
    agent: params.agent,
  });
}
