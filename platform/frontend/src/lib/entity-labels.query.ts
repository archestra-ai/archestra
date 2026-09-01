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

/** One label as the write endpoints accept it. */
type LabelInput = {
  key: string;
  value: string;
  keyId?: string;
  valueId?: string;
};

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
 * Every entity writes through its own `PUT <basePath>/:id/labels`, not its
 * normal update route: a labels-only patch is not expressible on several of
 * them — skills require `content` (and would fork a version), the OAuth
 * clients validate across fields, connectors merge credentials — so a shared
 * editor needs a shared endpoint. Those endpoints re-run each entity's own
 * modify authorization, so this is not a way around per-row permissions.
 *
 * Invalidating the entity's key refreshes both the rows and, because the
 * vocabulary hooks cache under the same prefix, the filter's key/value lists —
 * which a newly-typed label has just extended.
 */
export function createEntityLabelUpdate(config: {
  /** Cache namespace, matching the entity's `createEntityLabelQueries` key. */
  queryKey: string;
  setFn: (args: {
    path: { id: string };
    body: { labels: LabelInput[] };
  }) => Promise<{ data?: unknown; error?: unknown }>;
}) {
  const { queryKey, setFn } = config;

  return function useSaveLabels() {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: async (vars: { id: string; labels: LabelInput[] }) => {
        const { data, error } = await setFn({
          path: { id: vars.id },
          body: { labels: vars.labels },
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
  setFn: archestraApiSdk.setSkillLabels,
});

export const useSaveKnowledgeBaseLabels = createEntityLabelUpdate({
  queryKey: "knowledge-bases",
  setFn: archestraApiSdk.setKnowledgeBaseLabels,
});

export const useSaveKnowledgeFileLabels = createEntityLabelUpdate({
  queryKey: "knowledge-files",
  setFn: archestraApiSdk.setKnowledgeFileLabels,
});

export const useSaveConnectorLabels = createEntityLabelUpdate({
  queryKey: "knowledge-connectors",
  setFn: archestraApiSdk.setConnectorLabels,
});

export const useSaveLimitLabels = createEntityLabelUpdate({
  queryKey: "limits",
  setFn: archestraApiSdk.setLimitLabels,
});

export const useSaveModelLabels = createEntityLabelUpdate({
  queryKey: "llm-models",
  setFn: archestraApiSdk.setLlmProviderModelLabels,
});

export const useSaveLlmProviderApiKeyLabels = createEntityLabelUpdate({
  queryKey: "llm-provider-api-keys",
  setFn: archestraApiSdk.setLlmProviderApiKeyLabels,
});

export const useSaveVirtualApiKeyLabels = createEntityLabelUpdate({
  queryKey: "llm-virtual-keys",
  setFn: archestraApiSdk.setVirtualApiKeyLabels,
});

export const useSavePluginLabels = createEntityLabelUpdate({
  queryKey: "plugins",
  setFn: archestraApiSdk.setPluginLabels,
});

export const useSaveServiceAccountLabels = createEntityLabelUpdate({
  queryKey: "service-accounts",
  setFn: archestraApiSdk.setServiceAccountLabels,
});

export const useSaveLlmOauthClientLabels = createEntityLabelUpdate({
  queryKey: "llm-oauth-clients",
  setFn: archestraApiSdk.setLlmOauthClientLabels,
});

export const useSaveMcpOauthClientLabels = createEntityLabelUpdate({
  queryKey: "mcp-oauth-clients",
  setFn: archestraApiSdk.setMcpOauthClientLabels,
});

export const useSaveEnvironmentLabels = createEntityLabelUpdate({
  queryKey: "environments",
  setFn: archestraApiSdk.setEnvironmentLabels,
});
