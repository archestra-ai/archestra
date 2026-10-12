import type { ModelTierSelection } from "@/components/model-tier-pickers";

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
  defaultFastModelId?: string | null;
  defaultSmartModelId?: string | null;
  defaultAgentId?: string | null;
}

export interface AgentSettingsState {
  selectedApiKeyId: string;
  /** The models.id UUID of the selected default model. */
  defaultModel: string;
  tiers: ModelTierSelection;
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
    tiers: {
      fast: organization.defaultFastModelId ?? null,
      smart: organization.defaultSmartModelId ?? null,
    },
    defaultAgentId: organization.defaultAgentId ?? "",
  };
}

export function detectChanges(
  localState: AgentSettingsState,
  savedState: AgentSettingsState,
): { hasModelChanges: boolean; hasAgentChanges: boolean; hasChanges: boolean } {
  const hasModelChanges =
    localState.defaultModel !== savedState.defaultModel ||
    localState.tiers.fast !== savedState.tiers.fast ||
    localState.tiers.smart !== savedState.tiers.smart;
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
    // The default trio and its API key go together: persist all or nothing.
    const complete = Boolean(
      localState.defaultModel && localState.selectedApiKeyId,
    );
    payload.defaultModelId = complete ? localState.defaultModel : null;
    payload.defaultLlmApiKeyId = complete ? localState.selectedApiKeyId : null;
    payload.defaultFastModelId = complete ? localState.tiers.fast : null;
    payload.defaultSmartModelId = complete ? localState.tiers.smart : null;
  }

  if (hasAgentChanges) {
    payload.defaultAgentId = localState.defaultAgentId || null;
  }

  return payload;
}
