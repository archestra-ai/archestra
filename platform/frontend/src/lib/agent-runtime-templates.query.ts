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
export function useBuiltInRuntimeSettings() {
  return useQuery({
    queryKey: builtInsKey,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.listBuiltInAgentRuntimeSettings();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
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
      ]);
      toast.success("Agent Runtimes updated");
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
