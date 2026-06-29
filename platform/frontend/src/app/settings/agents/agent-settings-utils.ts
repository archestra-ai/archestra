interface ApiKey {
  id: string;
  provider: string;
  name: string;
  scope: string;
}

interface OrganizationData {
  /** FK to models(id) — the organization's default model. */
  defaultModelId?: string | null;
  defaultLlmApiKeyId?: string | null;
  defaultAgentId?: string | null;
}

export interface AgentSettingsState {
  selectedApiKeyId: string;
  /** The models.id UUID of the selected default model. */
  defaultModel: string;
  defaultAgentId: string;
}

export function resolveInitialState(
  organization: OrganizationData,
  apiKeys: ApiKey[],
): AgentSettingsState {
  let selectedApiKeyId = "";

  if (organization.defaultLlmApiKeyId) {
    const exactKey = apiKeys.find(
      (k) => k.id === organization.defaultLlmApiKeyId,
    );
    if (exactKey) {
      selectedApiKeyId = exactKey.id;
    }
  }

  return {
    selectedApiKeyId,
    defaultModel: organization.defaultModelId ?? "",
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
): Record<string, unknown> {
  const { hasModelChanges, hasAgentChanges } = detectChanges(
    localState,
    savedState,
  );
  const payload: Record<string, unknown> = {};

  if (hasModelChanges) {
    // The default model and its API key are a pair: persist both or neither.
    const complete = Boolean(
      localState.defaultModel && localState.selectedApiKeyId,
    );
    payload.defaultModelId = complete ? localState.defaultModel : null;
    payload.defaultLlmApiKeyId = complete ? localState.selectedApiKeyId : null;
  }

  if (hasAgentChanges) {
    payload.defaultAgentId = localState.defaultAgentId || null;
  }

  return payload;
}
