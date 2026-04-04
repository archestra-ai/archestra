interface ApiKey {
  id: string;
  provider: string;
  name: string;
  scope: string;
}

interface OrganizationData {
  defaultLlmModel?: string | null;
  defaultLlmProvider?: string | null;
  defaultLlmApiKeyId?: string | null;
  defaultAgentId?: string | null;
}

export interface AgentSettingsState {
  selectedApiKeyId: string;
  defaultModel: string;
  defaultAgentId: string;
}

export function resolveInitialState(
  organization: OrganizationData,
  apiKeys: ApiKey[],
): AgentSettingsState {
  let selectedApiKeyId = "";

  // Prefer exact API key ID when available; fall back to provider-based lookup
  if (organization.defaultLlmApiKeyId) {
    const exactKey = apiKeys.find(
      (k) => k.id === organization.defaultLlmApiKeyId,
    );
    if (exactKey) {
      selectedApiKeyId = exactKey.id;
    }
  }
  if (!selectedApiKeyId && organization.defaultLlmProvider) {
    const matchingKey = apiKeys.find(
      (k) => k.provider === organization.defaultLlmProvider,
    );
    if (matchingKey) {
      selectedApiKeyId = matchingKey.id;
    }
  }

  return {
    selectedApiKeyId,
    defaultModel: organization.defaultLlmModel ?? "",
    defaultAgentId: organization.defaultAgentId ?? "",
  };
}

export function detectChanges(
  localState: AgentSettingsState,
  savedState: AgentSettingsState,
): { hasModelChanges: boolean; hasAgentChanges: boolean; hasChanges: boolean } {
  const hasModelChanges = localState.defaultModel !== savedState.defaultModel;
  const hasApiKeyChanges =
    localState.selectedApiKeyId !== savedState.selectedApiKeyId;
  const hasAgentChanges =
    localState.defaultAgentId !== savedState.defaultAgentId;

  return {
    hasModelChanges: hasModelChanges || hasApiKeyChanges,
    hasAgentChanges,
    hasChanges: hasModelChanges || hasApiKeyChanges || hasAgentChanges,
  };
}

export function buildSavePayload(
  localState: AgentSettingsState,
  savedState: AgentSettingsState,
  apiKeys: ApiKey[],
): Record<string, unknown> {
  const { hasModelChanges, hasAgentChanges } = detectChanges(
    localState,
    savedState,
  );
  const payload: Record<string, unknown> = {};

  if (hasModelChanges) {
    let resolvedProvider: string | null = null;
    if (localState.defaultModel && localState.selectedApiKeyId) {
      const key = apiKeys.find((k) => k.id === localState.selectedApiKeyId);
      if (key) {
        resolvedProvider = key.provider;
      }
    }
    payload.defaultLlmModel = localState.defaultModel || null;
    payload.defaultLlmProvider = resolvedProvider;
    payload.defaultLlmApiKeyId =
      localState.defaultModel && localState.selectedApiKeyId
        ? localState.selectedApiKeyId
        : null;
  }

  if (hasAgentChanges) {
    payload.defaultAgentId = localState.defaultAgentId || null;
  }

  return payload;
}
