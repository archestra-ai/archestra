import {
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  type AgentRuntimeDefaults,
  archestraApiSdk,
  type archestraApiTypes,
  type LockableAgentRuntime,
  resolveAgentRuntimeTemplate,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { organizationKeys } from "@/lib/organization.query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type RuntimeTemplate =
  archestraApiTypes.GetAgentRuntimeTemplateResponses["200"];
export type RuntimeTemplateSummary =
  archestraApiTypes.ListAgentRuntimeTemplatesResponses["200"][number];
const catalogKey = ["agent-runtime-templates"] as const;
const builtInsKey = ["agent-runtime-templates", "built-ins"] as const;
const settingsKey = ["agent-runtime-template-settings"] as const;

export function useRuntimeTemplateCatalog() {
  return useQuery({
    queryKey: catalogKey,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listAgentRuntimeTemplates();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    refetchOnMount: "always",
    staleTime: 0,
  });
}

/** The settings administrators chose for the maintained runtimes. */
export function useBuiltInRuntimeSettings(enabled = true) {
  return useQuery({
    queryKey: builtInsKey,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.listBuiltInAgentRuntimeSettings();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled,
  });
}

/** A maintained runtime's defaults, as its administrators set them. */
export function useBuiltInRuntimeDefaults(): (
  id: AgentCatalogId,
) => AgentRuntimeDefaults | undefined {
  const { data } = useBuiltInRuntimeSettings();
  return (id) => data?.find((item) => item.id === id)?.settings;
}

/**
 * The account rule in a runtime's settings: which kind of account it names,
 * and the company connection and model it fixes. It holds at once for every
 * agent on the runtime and for every person, whatever an agent stores. An
 * absent field is left to each agent. The names, the connection's models and
 * the two `Missing` marks are filled in by the server, for readers who may
 * not read the connection itself.
 */
export type RuntimeAccounts = NonNullable<RuntimeTemplateSummary["accounts"]>;

/** What a runtime writes of its accounts: the choices, without the names. */
export function runtimeAccountsToSave(
  accounts: RuntimeAccounts | null | undefined,
): Pick<RuntimeAccounts, "kind" | "llmApiKeyId" | "modelId"> | undefined {
  if (!accounts) return undefined;
  const saved = {
    ...(accounts.kind && { kind: accounts.kind }),
    ...(accounts.llmApiKeyId && { llmApiKeyId: accounts.llmApiKeyId }),
    // A model belongs to a connection.
    ...(accounts.llmApiKeyId &&
      accounts.modelId && { modelId: accounts.modelId }),
  };
  return Object.keys(saved).length > 0 ? saved : undefined;
}

/**
 * The name of the locked Agent Runtime a runtime is an Agent of, or null.
 * Its settings are then the runtime's, and agent forms show them read-only.
 */
export function useLockedRuntimeName(
  runtime: Pick<LockableAgentRuntime, "image" | "command"> | null | undefined,
  catalogImages: Record<AgentCatalogId, string>,
): string | null {
  const { data: customs } = useRuntimeTemplateCatalog();
  const { data: builtIns } = useBuiltInRuntimeSettings();
  if (!runtime) return null;
  const ref = resolveAgentRuntimeTemplate({
    runtime,
    catalogImages,
    customTemplates: customs ?? [],
  });
  if (!ref) return null;
  if (ref.kind === "built-in")
    return builtIns?.find((item) => item.id === ref.id)?.locked
      ? AGENT_CATALOG_NAMES[ref.id]
      : null;
  const custom = customs?.find((item) => item.id === ref.id);
  return custom?.locked ? custom.name : null;
}

/**
 * The account rule of the Agent Runtime a runtime is an Agent of: the kind
 * of account it names (`kind`) and the company connection and model it
 * fixes, with their names. The rule holds for every agent on the runtime and
 * for every person, whatever an agent stores. Undefined while loading, null
 * for none, and for a reader the server sends no rule to.
 */
export function useRuntimeAccountRule(
  runtime: Pick<LockableAgentRuntime, "image" | "command"> | null | undefined,
  catalogImages: Record<AgentCatalogId, string>,
): RuntimeAccounts | null | undefined {
  const { data: customs } = useRuntimeTemplateCatalog();
  const ref =
    runtime && customs
      ? resolveAgentRuntimeTemplate({
          runtime,
          catalogImages,
          customTemplates: customs,
        })
      : null;
  const builtIns = useBuiltInRuntimeSettings(ref?.kind === "built-in");
  if (!runtime) return null;
  if (!customs) return undefined;
  if (!ref) return null;
  if (ref.kind === "custom") {
    return customs.find((item) => item.id === ref.id)?.accounts ?? null;
  }
  // A read that failed names nothing: the runtime is then taken to set no
  // rule.
  if (!builtIns.data) return builtIns.isError ? null : undefined;
  return (
    builtIns.data.find((item) => item.id === ref.id)?.settings.accounts ?? null
  );
}

export function useRuntimeTemplateSettings(enabled: boolean) {
  return useQuery({
    queryKey: settingsKey,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getRuntimeTemplateSettings();
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Runtime template settings were not returned");
      return data;
    },
    enabled,
    refetchOnWindowFocus: false,
    staleTime: 0,
    // Contains private configuration; deliberately never persisted to browser storage.
    gcTime: 0,
  });
}

export function useSaveRuntimeTemplateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.SaveRuntimeTemplateSettingsData["body"],
    ) => {
      const { data, error, response } =
        await archestraApiSdk.saveRuntimeTemplateSettings({ body });
      if (error) {
        if (response?.status === 409) {
          await Promise.all([
            client.invalidateQueries({ queryKey: settingsKey }),
            client.invalidateQueries({ queryKey: catalogKey }),
            client.invalidateQueries({ queryKey: organizationKeys.details() }),
          ]);
        }
        handleApiError(error);
        throw toApiError(error);
      }
      if (!data) throw new Error("Runtime template settings were not returned");
      return data;
    },
    onSuccess: async (data) => {
      client.setQueryData(settingsKey, data);
      await Promise.all([
        // Also refreshes the maintained runtimes' settings under it.
        client.invalidateQueries({ queryKey: catalogKey }),
        client.invalidateQueries({ queryKey: organizationKeys.details() }),
        // A runtime's account rule reaches every agent on it at once: an
        // open agent page or form reads the account again.
        client.invalidateQueries({ queryKey: ["agents"] }),
      ]);
      toast.success("Available runtimes updated");
    },
  });
}

export function useResolveRuntimeTemplate() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.getAgentRuntimeTemplate({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      if (!data) throw new Error("Runtime template was not returned");
      return data;
    },
  });
}
