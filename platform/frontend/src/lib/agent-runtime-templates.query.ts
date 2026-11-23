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

async function listRuntimeTemplateCatalog() {
  const { data, error } = await archestraApiSdk.listAgentRuntimeTemplates();
  throwOnApiError(error, { toastOnError: false });
  return data ?? [];
}

export function useRuntimeTemplateCatalog() {
  return useQuery({
    queryKey: catalogKey,
    queryFn: listRuntimeTemplateCatalog,
    refetchOnMount: "always",
    staleTime: 0,
  });
}

/**
 * The same list for something shown once per agent, such as a badge in every
 * row of a table: all of them share the one cached list, and a row that
 * mounts later asks for nothing while it is this fresh. A saved change to
 * the runtimes still refreshes it at once.
 */
export function useRuntimeTemplateCatalogShared(enabled = true) {
  return useQuery({
    queryKey: catalogKey,
    queryFn: listRuntimeTemplateCatalog,
    enabled,
    staleTime: 60_000,
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
  return (id) => {
    // With its account rule: a Claude runtime that names an account kind
    // starts a new agent on the Claude account of that kind, and one that
    // names none on the Claude account it stores. The rule itself never
    // reaches an agent's own runtime.
    return data?.find((item) => item.id === id)?.settings;
  };
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
):
  | Pick<
      RuntimeAccounts,
      "kind" | "llmApiKeyId" | "modelId" | "connectionModels"
    >
  | undefined {
  if (!accounts) return undefined;
  const planModels = Object.keys(accounts.connectionModels ?? {}).length > 0;
  const saved = {
    ...(accounts.kind && { kind: accounts.kind }),
    ...(accounts.llmApiKeyId && { llmApiKeyId: accounts.llmApiKeyId }),
    // A model belongs to a connection.
    ...(accounts.llmApiKeyId &&
      accounts.modelId && { modelId: accounts.modelId }),
    // A model per connection is set only where none is fixed.
    ...(!accounts.llmApiKeyId &&
      planModels && { connectionModels: accounts.connectionModels }),
  };
  return Object.keys(saved).length > 0 ? saved : undefined;
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
 * they may set it at all (undefined while loading); `canConfigure` is
 * whether they may configure it (undefined while loading); `readOnlyBy`
 * names the Agent Runtime whose settings the agent takes because the reader
 * may use it but not configure it.
 *
 * `accounts` is the runtime's account rule, undefined while loading and null
 * for none: the kind of account it names (`kind`) and the company connection
 * and model it fixes, with their names. The rule holds for every agent on
 * the runtime and for every person, whatever an agent stores. Nothing else
 * in a runtime's settings restricts its agents' accounts: a Claude account a
 * runtime stores is only what a new agent starts on.
 */
export function useAgentRuntimePermissions(
  runtime: Pick<TemplatedAgentRuntime, "image" | "command"> | null | undefined,
  catalogImages: Record<AgentCatalogId, string>,
): {
  canChange: boolean | undefined;
  canConfigure: boolean | undefined;
  readOnlyBy: string | null;
  accounts: RuntimeAccounts | null | undefined;
} {
  const { data: access } = useAgentRuntimeAccess();
  const { data: customs } = useRuntimeTemplateCatalog();
  const ref =
    runtime && customs
      ? resolveAgentRuntimeTemplate({
          runtime,
          catalogImages,
          customTemplates: customs,
        })
      : null;
  const entry = ref
    ? access?.runtimes.find((item) => item.id === ref.id)
    : undefined;
  // A runtime's rule is read from its own settings: a maintained runtime's
  // from the list of them, a custom one's from the catalog.
  const usable = entry?.canUse === true;
  const builtIns = useBuiltInRuntimeSettings(
    usable && ref?.kind === "built-in",
  );
  if (!access || !customs)
    return {
      canChange: undefined,
      canConfigure: undefined,
      readOnlyBy: null,
      accounts: undefined,
    };
  if (!runtime)
    return {
      canChange:
        access.canConfigureAny || access.runtimes.some((item) => item.canUse),
      canConfigure: access.canConfigureAny,
      readOnlyBy: null,
      accounts: null,
    };
  if (!ref || !entry)
    return {
      canChange: access.canConfigureAny,
      canConfigure: access.canConfigureAny,
      readOnlyBy: null,
      accounts: null,
    };
  const permissions = {
    canChange: entry.canUse,
    canConfigure: entry.canConfigure,
    readOnlyBy:
      entry.canUse && !entry.canConfigure
        ? ref.kind === "built-in"
          ? AGENT_CATALOG_NAMES[ref.id]
          : (customs.find((item) => item.id === ref.id)?.name ?? null)
        : null,
  };
  // The server sends a rule only to someone who may use the runtime.
  if (!usable) return { ...permissions, accounts: null };
  if (ref.kind === "custom") {
    return {
      ...permissions,
      accounts: customs.find((item) => item.id === ref.id)?.accounts ?? null,
    };
  }
  // A read that failed names nothing: the runtime is then taken to set no
  // rule.
  if (!builtIns.data) {
    return { ...permissions, accounts: builtIns.isError ? null : undefined };
  }
  return {
    ...permissions,
    accounts:
      builtIns.data.find((item) => item.id === ref.id)?.settings.accounts ??
      null,
  };
}

/**
 * How many existing agents of a runtime differ from its saved settings.
 * Null while there is no runtime to ask about.
 */
export function useAgentsBehindRuntime(id: string | null) {
  return useQuery({
    queryKey: [...behindKey, id],
    queryFn: () => countAgentsBehindRuntime(id as string),
    enabled: id !== null,
  });
}

/**
 * Asks afresh how many agents differ from a runtime's saved settings, for the
 * moment right after a save, when the cached count is the old settings'.
 */
export function useCountAgentsBehindRuntime() {
  const client = useQueryClient();
  return (id: string) =>
    client.fetchQuery({
      queryKey: [...behindKey, id],
      queryFn: () => countAgentsBehindRuntime(id),
      staleTime: 0,
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

async function countAgentsBehindRuntime(id: string): Promise<number> {
  const { data, error } = await archestraApiSdk.countAgentsBehindRuntime({
    path: { id },
  });
  throwOnApiError(error, { toastOnError: false });
  if (!data) throw new Error("Agent count was not returned");
  return data.agents;
}
