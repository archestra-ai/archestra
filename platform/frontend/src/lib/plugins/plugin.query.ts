import {
  archestraApiSdk,
  type archestraApiTypes,
  isUuid,
} from "@archestra/shared";
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { pluginsQueryKey } from "@/lib/connection-approval-query-keys";
import {
  getApiErrorInternalCode,
  getApiErrorMessage,
  handleApiError,
  throwOnApiError,
} from "@/lib/utils/api";

const {
  applyGithubPluginUpdate,
  createPlugin,
  deletePlugin,
  permanentlyDeletePlugin,
  restorePlugin,
  discoverGithubPluginMarketplace,
  getPlugin,
  getPlugins,
  getPluginVersion,
  getPluginVersions,
  importGithubPlugin,
  importGithubPluginMarketplace,
  previewGithubPlugin,
  previewGithubPluginUpdate,
  triggerPluginGithubSync,
  updatePlugin,
  updatePluginGithubSync,
} = archestraApiSdk;

export type PluginListItem =
  archestraApiTypes.GetPluginsResponses["200"][number];
export type PluginDetail = archestraApiTypes.GetPluginResponses["200"];
export type PluginVersionDetail =
  archestraApiTypes.GetPluginVersionResponses["200"];
export type CreatePluginBody = archestraApiTypes.CreatePluginData["body"];
export type UpdatePluginBody = archestraApiTypes.UpdatePluginData["body"];
export type GithubPluginSource =
  archestraApiTypes.PreviewGithubPluginData["body"];
export type GithubPluginPreview =
  archestraApiTypes.PreviewGithubPluginResponses["200"];
export type ImportGithubPluginBody =
  archestraApiTypes.ImportGithubPluginData["body"];
export type DiscoverGithubPluginMarketplaceBody =
  archestraApiTypes.DiscoverGithubPluginMarketplaceData["body"];
export type GithubPluginMarketplace =
  archestraApiTypes.DiscoverGithubPluginMarketplaceResponses["200"];
export type ImportGithubPluginMarketplaceBody =
  archestraApiTypes.ImportGithubPluginMarketplaceData["body"];

export function usePlugins(
  enabled = true,
  filters?: Pick<
    NonNullable<archestraApiTypes.GetPluginsData["query"]>,
    "labels" | "access" | "sharedWith" | "owner" | "status"
  >,
) {
  // Label and access filtering are resolved server-side (the junction table
  // and the grants are the only places those live), unlike this page's other
  // filters.
  const labels = filters?.labels;
  const access = filters?.access;
  const sharedWith = filters?.sharedWith;
  const owner = filters?.owner;
  // `deleted` asks for the trash instead of the live plugins.
  const status = filters?.status;
  return useQuery({
    queryKey: pluginsQueryKey({ labels, access, sharedWith, owner, status }),
    enabled,
    queryFn: async () => {
      const { data, error } = await getPlugins({
        query: { labels, access, sharedWith, owner, status },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function usePlugin(id: string | null) {
  return useQuery({
    queryKey: ["plugins", id],
    enabled: !!id,
    queryFn: async () => {
      // A malformed id names no plugin. Asking the API would only come back
      // as a validation error, which reads as a failed load, not "not found".
      if (!isUuid(id as string)) return null;
      const { data, error } = await getPlugin({
        path: { id: id as string },
      });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
  });
}

/** How many versions the history loads per page. */
const PLUGIN_VERSIONS_PAGE_SIZE = 50;

/**
 * A plugin's versions, newest first, a page at a time. Not held past
 * staleness: the list grows at its head from outside this tab (a Git update
 * applied by someone else, an edit over the API).
 */
export function usePluginVersions(id: string | null) {
  return useInfiniteQuery({
    queryKey: ["plugins", id, "versions"],
    enabled: !!id,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await getPluginVersions({
        path: { id: id as string },
        query: { limit: PLUGIN_VERSIONS_PAGE_SIZE, offset: pageParam },
      });
      // The history dialog shows its own failure with a retry.
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage?.pagination.hasNext
        ? allPages.reduce(
            (loaded, page) => loaded + (page?.data.length ?? 0),
            0,
          )
        : undefined,
  });
}

/** One version of a plugin with its files. Null when it does not exist. */
export function usePluginVersion(id: string | null, version: number | null) {
  return useQuery({
    // Outside the `["plugins", ...]` prefix on purpose: a version never
    // changes, so no plugin write should make the app download it again.
    queryKey: ["plugin-version", id, version],
    enabled: !!id && version !== null && version > 0,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await getPluginVersion({
        path: { id: id as string, version: version as number },
      });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
  });
}

/**
 * Restore a plugin to an earlier version by saving that version's files to
 * it. The restored files become a new version, so nothing in the history is
 * rewritten. `baseContentHash` is the plugin's hash when the restore was
 * confirmed: the save is refused if the files have changed since.
 *
 * Resolves to the plugin as saved, or null when the save was refused (the
 * toast says why).
 */
export function useRestorePluginVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      pluginId: string;
      version: number;
      baseContentHash: string;
    }) => {
      const { data: snapshot, error: readError } = await getPluginVersion({
        path: { id: params.pluginId, version: params.version },
      });
      if (readError || !snapshot) {
        handleApiError(readError ?? new Error("Version not found"));
        return null;
      }
      const { data, error } = await updatePlugin({
        path: { id: params.pluginId },
        body: {
          files: snapshot.files.map(({ path, content, encoding, mode }) => ({
            path,
            content,
            encoding,
            mode,
          })),
          baseContentHash: params.baseContentHash,
        },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, params) => {
      if (!data) return;
      queryClient.setQueryData(["plugins", params.pluginId], data);
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      toast.success(`Restored version ${params.version}`);
    },
    onError: (error) => handleApiError(error),
  });
}

export function useCreatePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreatePluginBody) => {
      const { data, error } = await createPlugin({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      toast.success("Plugin created");
      return invalidatePluginCapabilities(queryClient);
    },
  });
}

export function usePreviewGithubPlugin() {
  return useMutation({
    mutationFn: async (body: GithubPluginSource) => {
      const { data, error } = await previewGithubPlugin({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function usePreviewGithubPluginUpdate(id: string) {
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await previewGithubPluginUpdate({
        path: { id },
        body: {},
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function useApplyGithubPluginUpdate(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (approvedCommitSha: string) => {
      const { data, error } = await applyGithubPluginUpdate({
        path: { id },
        body: { approvedCommitSha },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.setQueryData(["plugins", id], data);
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      toast.success("Update approved and applied");
    },
  });
}

export function useImportGithubPlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ImportGithubPluginBody) => {
      const { data, error } = await importGithubPlugin({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      toast.success("Plugin imported");
      return invalidatePluginCapabilities(queryClient);
    },
  });
}

export function useDiscoverGithubPluginMarketplace() {
  return useMutation({
    mutationFn: async (body: DiscoverGithubPluginMarketplaceBody) => {
      const { data, error } = await discoverGithubPluginMarketplace({ body });
      if (error) {
        return {
          data: null,
          errorMessage: getApiErrorMessage(error),
          errorCode: getApiErrorInternalCode(error) ?? null,
        };
      }
      return { data, errorMessage: null, errorCode: null };
    },
  });
}

export function useImportGithubPluginMarketplace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ImportGithubPluginMarketplaceBody) => {
      const { data, error } = await importGithubPluginMarketplace({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      if (data.created.length > 0) {
        toast.success(
          `${data.created.length} plugin${data.created.length === 1 ? "" : "s"} imported`,
        );
      }
      if (data.failed.length > 0) {
        const reasons = data.failed
          .slice(0, 3)
          .map((failure) => `${failure.name}: ${failure.error}`)
          .join(" · ");
        toast.warning(
          `${data.failed.length} plugin import${data.failed.length === 1 ? "" : "s"} failed`,
          {
            description:
              data.failed.length > 3
                ? `${reasons} · +${data.failed.length - 3} more`
                : reasons,
            duration: 10_000,
          },
        );
      }
      if (data.created.length > 0) {
        return invalidatePluginCapabilities(queryClient);
      }
    },
  });
}

export function useUpdatePlugin(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdatePluginBody) => {
      const { data, error } = await updatePlugin({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        // A save refused because the files changed elsewhere: read the plugin
        // again, so that discarding the draft shows what is saved now.
        queryClient.invalidateQueries({ queryKey: ["plugins", id] });
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.setQueryData(["plugins", id], data);
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      toast.success("Plugin saved");
    },
  });
}

export function useUpdatePluginGithubSync(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (interval: "15m" | "1h" | "1d" | null) => {
      const { data, error } = await updatePluginGithubSync({
        path: { id },
        body: { interval },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.setQueryData(["plugins", id], data);
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      toast.success(
        data.githubSyncInterval
          ? "Update checks updated"
          : "Update checks turned off",
      );
    },
  });
}

export function useTriggerPluginGithubSync(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await triggerPluginGithubSync({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data?.queued ?? false;
    },
    onSuccess: (queued) => {
      if (queued === null) return;
      toast.success(
        queued ? "Update check queued" : "Update check already running",
      );
      for (const delay of [1_000, 3_000, 8_000]) {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["plugins", id] });
          queryClient.invalidateQueries({ queryKey: ["plugins"] });
        }, delay);
      }
    },
  });
}

/**
 * Deletes one plugin or several. Every place that deletes plugins goes
 * through this one mutation, so the outcome is reported the same way from a
 * row, the bulk bar and the plugin's page.
 */
export function useDeletePlugins() {
  return usePluginsMutation({
    request: (id) => deletePlugin({ path: { id } }),
    words: { done: "deleted", doing: "delete" },
  });
}

/** Restores one deleted plugin or several, reported like the delete. */
export function useRestorePlugins() {
  return usePluginsMutation({
    request: (id) => restorePlugin({ path: { id } }),
    words: { done: "restored", doing: "restore" },
  });
}

/**
 * Destroys one deleted plugin or several for good, reported like the delete.
 * The API answers "not found" to anyone but a global admin.
 */
export function usePermanentlyDeletePlugins() {
  return usePluginsMutation({
    request: (id) => permanentlyDeletePlugin({ path: { id } }),
    words: { done: "permanently deleted", doing: "permanently delete" },
  });
}

export { isDeliverablePlugin } from "./plugin-eligibility";

// === Internal helpers ===

/**
 * A new plugin is written with its author's full-access grants on it (read,
 * use, update, delete, manage-permissions), which the cached capability list
 * predates. Edit, install, delete, and permissions controls read that list, so
 * refetch it before the create or import flow navigates to the new plugin.
 */
/**
 * One request per plugin for a batch of them, with one report for the batch:
 * the shape every plugin action that works on a row and on a selection takes.
 */
function usePluginsMutation(params: {
  request: (id: string) => Promise<{ error?: unknown }>;
  /** The action as a past participle and as a verb: "deleted", "delete". */
  words: { done: string; doing: string };
}) {
  const queryClient = useQueryClient();
  const { request, words } = params;
  return useMutation({
    mutationFn: async (plugins: Array<{ id: string; name: string }>) => {
      const outcomes = await Promise.all(
        plugins.map(async (plugin) => {
          const { error } = await request(plugin.id);
          return { plugin, error };
        }),
      );
      return {
        succeeded: outcomes
          .filter(({ error }) => !error)
          .map(({ plugin }) => plugin),
        failed: outcomes.filter(({ error }) => !!error),
      };
    },
    onSuccess: ({ succeeded, failed }) => {
      for (const plugin of succeeded) {
        queryClient.removeQueries({ queryKey: ["plugins", plugin.id] });
      }
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      const total = succeeded.length + failed.length;
      const Done = words.done.charAt(0).toUpperCase() + words.done.slice(1);
      if (total === 1 && failed.length === 1) {
        // One plugin, one reason: say the reason itself.
        handleApiError(failed[0].error);
      } else if (failed.length === 0) {
        toast.success(
          total === 1 ? `Plugin ${words.done}` : `${Done} ${total} plugins`,
        );
      } else if (succeeded.length === 0) {
        toast.error(`Couldn't ${words.doing} ${failed.length} plugins`);
      } else {
        toast.warning(
          `${Done} ${succeeded.length} of ${total} plugins; ${failed.length} could not be ${words.done}`,
        );
      }
      if (succeeded.length > 0) {
        return invalidatePluginCapabilities(queryClient);
      }
    },
  });
}

function invalidatePluginCapabilities(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    queryKey: authQueryKeys.scopedCapabilities(),
  });
}
