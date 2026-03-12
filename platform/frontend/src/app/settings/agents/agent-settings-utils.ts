interface ApiKey {
  id: string;
  provider: string;
  name: string;
  scope: string;
}

interface OrganizationData {
  defaultLlmModel?: string | null;
  defaultLlmProvider?: string | null;
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
  if (organization.defaultLlmProvider) {
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
  organization: OrganizationData,
): { hasModelChanges: boolean; hasAgentChanges: boolean; hasChanges: boolean } {
  const serverModel = organization.defaultLlmModel ?? "";
  const serverAgentId = organization.defaultAgentId ?? "";

  const hasModelChanges = localState.defaultModel !== serverModel;
  const hasAgentChanges = localState.defaultAgentId !== serverAgentId;

  return {
    hasModelChanges,
    hasAgentChanges,
    hasChanges: hasModelChanges || hasAgentChanges,
  };
}

export function buildSavePayload(
  localState: AgentSettingsState,
  organization: OrganizationData,
  apiKeys: ApiKey[],
): Record<string, unknown> {
  const { hasModelChanges, hasAgentChanges } = detectChanges(
    localState,
    organization,
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
  }

  if (hasAgentChanges) {
    payload.defaultAgentId = localState.defaultAgentId || null;
  }

  return payload;
}
