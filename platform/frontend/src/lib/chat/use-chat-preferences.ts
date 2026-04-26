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

interface AgentInfo {
  llmModel?: string | null;
  llmApiKeyId?: string | null;
}

interface OrganizationInfo {
  defaultLlmModel?: string | null;
  defaultLlmApiKeyId?: string | null;
}

interface ChatContext {
  chatApiKeys: Array<{
    id: string;
    provider: string;
    bestModelId?: string | null;
  }>;
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
 * Priority: user override > agent config > organization default > API key best model.
 * Returns null when no configured/default/best model is known yet.
 */
export function resolveInitialModel(
  params: ResolveInitialModelParams,
): ResolvedModel | null {
  const { agent, chatApiKeys, organization } = params;

  const userOverride = getSavedModelOverride();
  if (userOverride) {
    return {
      modelId: userOverride,
      apiKeyId: null,
      source: "user",
    };
  }

  if (agent?.llmModel) {
    return {
      modelId: agent.llmModel,
      apiKeyId: agent.llmApiKeyId ?? null,
      source: "agent",
    };
  }

  if (organization?.defaultLlmModel) {
    const orgKeyId = organization.defaultLlmApiKeyId ?? null;
    const orgKeyAvailable =
      orgKeyId && chatApiKeys.some((k) => k.id === orgKeyId);
    return {
      modelId: organization.defaultLlmModel,
      apiKeyId: orgKeyAvailable ? orgKeyId : null,
      source: "organization",
    };
  }

  for (const key of chatApiKeys) {
    if (key.bestModelId) {
      return {
        modelId: key.bestModelId,
        apiKeyId: key.id,
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
