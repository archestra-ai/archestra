import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils";

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

/**
 * Build the mutation that saves one row's labels from a list page.
 *
 * The body is supplied by the caller rather than assembled here: most update
 * endpoints accept a labels-only patch, but some (the OAuth clients) validate
 * across fields and need the row's current shape resent alongside. Invalidating
 * the entity's own key refreshes the rows; invalidating its `labels` key
 * refreshes the filter vocabulary, which a new key/value has just extended.
 */
export function createEntityLabelUpdate<TBody, TPath = { id: string }>(config: {
  /** Cache namespace, matching the entity's `createEntityLabelQueries` key. */
  queryKey: string;
  updateFn: (args: {
    path: TPath;
    body: TBody;
  }) => Promise<{ data?: unknown; error?: unknown }>;
  /** Route param shape, for the endpoints whose id is not called `id`. */
  pathFor?: (id: string) => TPath;
}) {
  const { queryKey, updateFn, pathFor } = config;

  return function useSaveLabels() {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: async (vars: { id: string; body: TBody }) => {
        const { data, error } = await updateFn({
          path: pathFor ? pathFor(vars.id) : ({ id: vars.id } as TPath),
          body: vars.body,
        });
        if (error) {
          handleApiError(error);
          return null;
        }
        return data;
      },
      onSuccess: (data) => {
        if (!data) return;
        queryClient.invalidateQueries({ queryKey: [queryKey] });
        toast.success("Labels saved");
      },
    });
  };
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

// =============================================================================
// Per-entity label save mutations, for the row-level `EntityLabelsDialog`
// =============================================================================

export const useSaveSkillLabels = createEntityLabelUpdate({
  queryKey: "skills",
  updateFn: archestraApiSdk.updateSkill,
});

export const useSaveKnowledgeBaseLabels = createEntityLabelUpdate({
  queryKey: "knowledge-bases",
  updateFn: archestraApiSdk.updateKnowledgeBase,
});

export const useSaveKnowledgeFileLabels = createEntityLabelUpdate({
  queryKey: "knowledge-files",
  updateFn: archestraApiSdk.updateKnowledgeFile,
  pathFor: (id) => ({ fileId: id }),
});

export const useSaveConnectorLabels = createEntityLabelUpdate({
  queryKey: "knowledge-connectors",
  updateFn: archestraApiSdk.updateConnector,
});

export const useSaveLimitLabels = createEntityLabelUpdate({
  queryKey: "limits",
  updateFn: archestraApiSdk.updateLimit,
});

export const useSaveModelLabels = createEntityLabelUpdate({
  queryKey: "llm-models",
  updateFn: archestraApiSdk.updateModel,
});

export const useSaveLlmProviderApiKeyLabels = createEntityLabelUpdate({
  queryKey: "llm-provider-api-keys",
  updateFn: archestraApiSdk.updateLlmProviderApiKey,
});

export const useSaveVirtualApiKeyLabels = createEntityLabelUpdate({
  queryKey: "llm-virtual-keys",
  updateFn: archestraApiSdk.updateVirtualApiKey,
});

export const useSavePluginLabels = createEntityLabelUpdate({
  queryKey: "plugins",
  updateFn: archestraApiSdk.updatePlugin,
});

export const useSaveServiceAccountLabels = createEntityLabelUpdate({
  queryKey: "service-accounts",
  updateFn: archestraApiSdk.updateServiceAccount,
});

export const useSaveLlmOauthClientLabels = createEntityLabelUpdate({
  queryKey: "llm-oauth-clients",
  updateFn: archestraApiSdk.updateLlmOauthClient,
});

export const useSaveMcpOauthClientLabels = createEntityLabelUpdate({
  queryKey: "mcp-oauth-clients",
  updateFn: archestraApiSdk.updateMcpOauthClient,
});

export const useSaveEnvironmentLabels = createEntityLabelUpdate({
  queryKey: "environments",
  updateFn: archestraApiSdk.updateEnvironment,
});
