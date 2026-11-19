import {
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  type AgentRuntimeDefaults,
  archestraApiSdk,
  type archestraApiTypes,
  resolveAgentRuntimeTemplate,
  type TemplatedAgentRuntime,
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
const accessKey = ["agent-runtime-access"] as const;
const behindKey = ["agent-runtime-agents-behind"] as const;

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

/** Which Agent Runtimes the reader may put agents on and configure. */
export function useAgentRuntimeAccess() {
  return useQuery({
    queryKey: accessKey,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listAgentRuntimeAccess();
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Agent Runtime access was not returned");
      return data;
    },
  });
}

/**
 * What the reader may do with an agent's runtime. `canChange` is whether
 * they may set it at all (undefined while loading); `readOnlyBy` names the
 * Agent Runtime whose settings the agent takes because the reader may use
 * it but not configure it.
 */
export function useAgentRuntimePermissions(
  runtime: Pick<TemplatedAgentRuntime, "image" | "command"> | null | undefined,
  catalogImages: Record<AgentCatalogId, string>,
): { canChange: boolean | undefined; readOnlyBy: string | null } {
  const { data: access } = useAgentRuntimeAccess();
  const { data: customs } = useRuntimeTemplateCatalog();
  if (!access || !customs) return { canChange: undefined, readOnlyBy: null };
  if (!runtime)
    return {
      canChange:
        access.canConfigureAny || access.runtimes.some((item) => item.canUse),
      readOnlyBy: null,
    };
  const ref = resolveAgentRuntimeTemplate({
    runtime,
    catalogImages,
    customTemplates: customs,
  });
  const entry = ref && access.runtimes.find((item) => item.id === ref.id);
  if (!ref || !entry)
    return { canChange: access.canConfigureAny, readOnlyBy: null };
  return {
    canChange: entry.canUse,
    readOnlyBy:
      entry.canUse && !entry.canConfigure
        ? ref.kind === "built-in"
          ? AGENT_CATALOG_NAMES[ref.id]
          : (customs.find((item) => item.id === ref.id)?.name ?? null)
        : null,
  };
}

/**
 * How many existing agents of a runtime differ from its saved settings.
 * Null while there is no runtime to ask about.
 */
export function useAgentsBehindRuntime(id: string | null) {
  return useQuery({
    queryKey: [...behindKey, id],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.countAgentsBehindRuntime({
        path: { id: id as string },
      });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Agent count was not returned");
      return data.agents;
    },
    enabled: id !== null,
  });
}

/** Give every existing agent of a runtime that runtime's current settings. */
export function useApplyAgentRuntimeToAgents() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.applyAgentRuntimeToAgents({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      if (!data) throw new Error("Agent Runtime update was not returned");
      return data;
    },
    onSuccess: async ({ updated }) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["agents"] }),
        client.invalidateQueries({ queryKey: behindKey }),
      ]);
      toast.success(
        updated === 0
          ? "Every agent already uses these settings"
          : `Updated ${updated} ${updated === 1 ? "agent" : "agents"} to the saved settings`,
      );
    },
  });
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
        client.invalidateQueries({ queryKey: accessKey }),
        client.invalidateQueries({ queryKey: behindKey }),
        client.invalidateQueries({ queryKey: organizationKeys.details() }),
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
