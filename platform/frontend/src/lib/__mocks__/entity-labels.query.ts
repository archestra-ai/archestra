import { vi } from "vitest";

/**
 * Stubs for every label hook, so a page test can render a list page without
 * standing up a QueryClient just to satisfy the label editor.
 *
 * The vocabulary hooks return no keys, which is also what the real ones do
 * before anything is labelled — the filter control hides itself in that case,
 * so a test that does not care about labels sees the page it expects.
 */

const noKeys = () => ({ data: [] as string[] });
const noValues = () => ({ data: [] as string[] });
const noSave = () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) });

export const useConnectorLabelKeys = noKeys;
export const useEnvironmentLabelKeys = noKeys;
export const useKnowledgeBaseLabelKeys = noKeys;
export const useKnowledgeFileLabelKeys = noKeys;
export const useLimitLabelKeys = noKeys;
export const useLlmOauthClientLabelKeys = noKeys;
export const useLlmProviderApiKeyLabelKeys = noKeys;
export const useMcpOauthClientLabelKeys = noKeys;
export const useModelLabelKeys = noKeys;
export const usePluginLabelKeys = noKeys;
export const useServiceAccountLabelKeys = noKeys;
export const useSkillLabelKeys = noKeys;
export const useVirtualApiKeyLabelKeys = noKeys;

export const useConnectorLabelValues = noValues;
export const useEnvironmentLabelValues = noValues;
export const useKnowledgeBaseLabelValues = noValues;
export const useKnowledgeFileLabelValues = noValues;
export const useLimitLabelValues = noValues;
export const useLlmOauthClientLabelValues = noValues;
export const useLlmProviderApiKeyLabelValues = noValues;
export const useMcpOauthClientLabelValues = noValues;
export const useModelLabelValues = noValues;
export const usePluginLabelValues = noValues;
export const useServiceAccountLabelValues = noValues;
export const useSkillLabelValues = noValues;
export const useVirtualApiKeyLabelValues = noValues;

