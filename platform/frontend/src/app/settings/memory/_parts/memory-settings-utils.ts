import type { archestraApiTypes } from "@shared";

export type ToggleValue = "enabled" | "disabled";

export type MemorySettingsState = {
  memoryExtractionEnabled: ToggleValue;
  memoryInjectionEnabled: ToggleValue;
  memoryIdleDelaySeconds: string;
  memoryExtractorMaxTokens: string;
  memoryExtractorModel: string;
  memoryExtractorChatApiKeyId: string;
  memoryInjectionTokenBudget: string;
  memoryInjectionTopK: string;
  memoryTombstoneTtlDays: string;
  memoryCandidateTtlDays: string;
  memoryMaxContentLength: string;
  memoryMaxCandidatesPerExtraction: string;
};

export function resolveInitialState(organization: {
  memoryExtractionEnabled?: boolean | null;
  memoryInjectionEnabled?: boolean | null;
  memoryIdleDelaySeconds?: number | null;
  memoryExtractorMaxTokens?: number | null;
  memoryExtractorModel?: string | null;
  memoryExtractorChatApiKeyId?: string | null;
  memoryInjectionTokenBudget?: number | null;
  memoryInjectionTopK?: number | null;
  memoryTombstoneTtlDays?: number | null;
  memoryCandidateTtlDays?: number | null;
  memoryMaxContentLength?: number | null;
  memoryMaxCandidatesPerExtraction?: number | null;
}): MemorySettingsState {
  return {
    memoryExtractionEnabled: organization.memoryExtractionEnabled
      ? "enabled"
      : "disabled",
    memoryInjectionEnabled: organization.memoryInjectionEnabled
      ? "enabled"
      : "disabled",
    memoryIdleDelaySeconds: String(organization.memoryIdleDelaySeconds ?? 300),
    memoryExtractorMaxTokens: String(
      organization.memoryExtractorMaxTokens ?? 800,
    ),
    memoryExtractorModel: organization.memoryExtractorModel ?? "",
    memoryExtractorChatApiKeyId: organization.memoryExtractorChatApiKeyId ?? "",
    memoryInjectionTokenBudget: String(
      organization.memoryInjectionTokenBudget ?? 600,
    ),
    memoryInjectionTopK: String(organization.memoryInjectionTopK ?? 10),
    memoryTombstoneTtlDays: String(organization.memoryTombstoneTtlDays ?? 90),
    memoryCandidateTtlDays: String(organization.memoryCandidateTtlDays ?? 30),
    memoryMaxContentLength: String(organization.memoryMaxContentLength ?? 500),
    memoryMaxCandidatesPerExtraction: String(
      organization.memoryMaxCandidatesPerExtraction ?? 5,
    ),
  };
}

export function detectChanges(
  current: MemorySettingsState,
  saved: MemorySettingsState,
): boolean {
  return JSON.stringify(current) !== JSON.stringify(saved);
}

export function buildSavePayload(
  current: MemorySettingsState,
  saved: MemorySettingsState,
): NonNullable<archestraApiTypes.UpdateMemorySettingsData["body"]> {
  const payload: NonNullable<
    archestraApiTypes.UpdateMemorySettingsData["body"]
  > = {};

  if (current.memoryExtractionEnabled !== saved.memoryExtractionEnabled) {
    payload.memoryExtractionEnabled =
      current.memoryExtractionEnabled === "enabled";
  }
  if (current.memoryInjectionEnabled !== saved.memoryInjectionEnabled) {
    payload.memoryInjectionEnabled =
      current.memoryInjectionEnabled === "enabled";
  }
  if (current.memoryIdleDelaySeconds !== saved.memoryIdleDelaySeconds) {
    payload.memoryIdleDelaySeconds = Number(current.memoryIdleDelaySeconds);
  }
  if (current.memoryExtractorMaxTokens !== saved.memoryExtractorMaxTokens) {
    payload.memoryExtractorMaxTokens = Number(current.memoryExtractorMaxTokens);
  }
  if (current.memoryExtractorModel !== saved.memoryExtractorModel) {
    payload.memoryExtractorModel = current.memoryExtractorModel || null;
  }
  if (
    current.memoryExtractorChatApiKeyId !== saved.memoryExtractorChatApiKeyId
  ) {
    payload.memoryExtractorChatApiKeyId =
      current.memoryExtractorChatApiKeyId || null;
  }
  if (current.memoryInjectionTokenBudget !== saved.memoryInjectionTokenBudget) {
    payload.memoryInjectionTokenBudget = Number(
      current.memoryInjectionTokenBudget,
    );
  }
  if (current.memoryInjectionTopK !== saved.memoryInjectionTopK) {
    payload.memoryInjectionTopK = Number(current.memoryInjectionTopK);
  }
  if (current.memoryTombstoneTtlDays !== saved.memoryTombstoneTtlDays) {
    payload.memoryTombstoneTtlDays = Number(current.memoryTombstoneTtlDays);
  }
  if (current.memoryCandidateTtlDays !== saved.memoryCandidateTtlDays) {
    payload.memoryCandidateTtlDays = Number(current.memoryCandidateTtlDays);
  }
  if (current.memoryMaxContentLength !== saved.memoryMaxContentLength) {
    payload.memoryMaxContentLength = Number(current.memoryMaxContentLength);
  }
  if (
    current.memoryMaxCandidatesPerExtraction !==
    saved.memoryMaxCandidatesPerExtraction
  ) {
    payload.memoryMaxCandidatesPerExtraction = Number(
      current.memoryMaxCandidatesPerExtraction,
    );
  }

  return payload;
}
