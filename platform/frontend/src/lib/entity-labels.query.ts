import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils";

type LabelKeysFn = () => Promise<{
  data?: string[];
  error?: unknown;
}>;

type LabelValuesFn = (args: {
  query: { key?: string };
}) => Promise<{ data?: string[]; error?: unknown }>;

/**
 * Build the two hooks a label filter needs for one entity.
 *
 * Every labelled entity exposes the same pair of vocabulary endpoints, so the
 * hooks differ only in which generated SDK functions they call and the query
 * key they cache under.
 *
 * `useValues` is deliberately lazy: the filter popover only asks for a key's
 * values once that key's sub-popover opens, so listing an entity does not pull
 * the whole vocabulary.
 */
export function createEntityLabelQueries(config: {
  /** Cache namespace, normally the entity's collection path segment. */
  queryKey: string;
  keysFn: LabelKeysFn;
  valuesFn: LabelValuesFn;
  /** When false, the keys query is skipped (caller lacks read permission). */
  useEnabled?: () => boolean;
}) {
  const { queryKey, keysFn, valuesFn, useEnabled } = config;

  function useLabelKeys() {
    const enabled = useEnabled?.() ?? true;
    return useQuery({
      queryKey: [queryKey, "labels", "keys"],
      enabled,
      queryFn: async () => {
        const { data, error } = await keysFn();
        throwOnApiError(error, { toastOnError: false });
        return data ?? [];
      },
    });
  }

  function useLabelValues(params?: { key?: string }) {
    const key = params?.key;
    return useQuery({
      queryKey: [queryKey, "labels", "values", key],
      enabled: key !== undefined,
      queryFn: async () => {
        const { data, error } = await valuesFn({ query: key ? { key } : {} });
        throwOnApiError(error, { toastOnError: false });
        return data ?? [];
      },
    });
  }

  return { useLabelKeys, useLabelValues };
}

// =============================================================================
// Per-entity hooks
// =============================================================================

export const {
  useLabelKeys: useSkillLabelKeys,
  useLabelValues: useSkillLabelValues,
} = createEntityLabelQueries({
  queryKey: "skills",
  keysFn: archestraApiSdk.skillLabelKeys,
  valuesFn: archestraApiSdk.skillLabelValues,
});

export const {
  useLabelKeys: useKnowledgeBaseLabelKeys,
  useLabelValues: useKnowledgeBaseLabelValues,
} = createEntityLabelQueries({
  queryKey: "knowledge-bases",
  keysFn: archestraApiSdk.knowledgeBaseLabelKeys,
  valuesFn: archestraApiSdk.knowledgeBaseLabelValues,
});

export const {
  useLabelKeys: useKnowledgeFileLabelKeys,
  useLabelValues: useKnowledgeFileLabelValues,
} = createEntityLabelQueries({
  queryKey: "knowledge-files",
  keysFn: archestraApiSdk.knowledgeFileLabelKeys,
  valuesFn: archestraApiSdk.knowledgeFileLabelValues,
});

export const {
  useLabelKeys: useConnectorLabelKeys,
  useLabelValues: useConnectorLabelValues,
} = createEntityLabelQueries({
  queryKey: "knowledge-connectors",
  keysFn: archestraApiSdk.connectorLabelKeys,
  valuesFn: archestraApiSdk.connectorLabelValues,
});

export const {
  useLabelKeys: useLimitLabelKeys,
  useLabelValues: useLimitLabelValues,
} = createEntityLabelQueries({
  queryKey: "limits",
  keysFn: archestraApiSdk.limitLabelKeys,
  valuesFn: archestraApiSdk.limitLabelValues,
});

export const {
  useLabelKeys: useModelLabelKeys,
  useLabelValues: useModelLabelValues,
} = createEntityLabelQueries({
  queryKey: "llm-models",
  keysFn: archestraApiSdk.llmProviderModelLabelKeys,
  valuesFn: archestraApiSdk.llmProviderModelLabelValues,
});

export const {
  useLabelKeys: useLlmProviderApiKeyLabelKeys,
  useLabelValues: useLlmProviderApiKeyLabelValues,
} = createEntityLabelQueries({
  queryKey: "llm-provider-api-keys",
  keysFn: archestraApiSdk.llmProviderApiKeyLabelKeys,
  valuesFn: archestraApiSdk.llmProviderApiKeyLabelValues,
});

export const {
  useLabelKeys: useVirtualApiKeyLabelKeys,
  useLabelValues: useVirtualApiKeyLabelValues,
} = createEntityLabelQueries({
  queryKey: "llm-virtual-keys",
  keysFn: archestraApiSdk.virtualApiKeyLabelKeys,
  valuesFn: archestraApiSdk.virtualApiKeyLabelValues,
});

export const {
  useLabelKeys: usePluginLabelKeys,
  useLabelValues: usePluginLabelValues,
} = createEntityLabelQueries({
  queryKey: "plugins",
  keysFn: archestraApiSdk.pluginLabelKeys,
  valuesFn: archestraApiSdk.pluginLabelValues,
});

export const {
  useLabelKeys: useServiceAccountLabelKeys,
  useLabelValues: useServiceAccountLabelValues,
} = createEntityLabelQueries({
  queryKey: "service-accounts",
  keysFn: archestraApiSdk.serviceAccountLabelKeys,
  valuesFn: archestraApiSdk.serviceAccountLabelValues,
});

export const {
  useLabelKeys: useLlmOauthClientLabelKeys,
  useLabelValues: useLlmOauthClientLabelValues,
} = createEntityLabelQueries({
  queryKey: "llm-oauth-clients",
  keysFn: archestraApiSdk.llmOauthClientLabelKeys,
  valuesFn: archestraApiSdk.llmOauthClientLabelValues,
});

export const {
  useLabelKeys: useMcpOauthClientLabelKeys,
  useLabelValues: useMcpOauthClientLabelValues,
} = createEntityLabelQueries({
  queryKey: "mcp-oauth-clients",
  keysFn: archestraApiSdk.mcpOauthClientLabelKeys,
  valuesFn: archestraApiSdk.mcpOauthClientLabelValues,
});

export const {
  useLabelKeys: useEnvironmentLabelKeys,
  useLabelValues: useEnvironmentLabelValues,
} = createEntityLabelQueries({
  queryKey: "environments",
  keysFn: archestraApiSdk.environmentLabelKeys,
  valuesFn: archestraApiSdk.environmentLabelValues,
});
