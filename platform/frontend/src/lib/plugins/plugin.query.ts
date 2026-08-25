import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getApiErrorMessage,
  handleApiError,
  throwOnApiError,
} from "@/lib/utils";

const {
  applyGithubPluginUpdate,
  createPlugin,
  deletePlugin,
  discoverGithubPluginMarketplace,
  getPlugin,
  getPlugins,
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

export function usePlugins(enabled = true) {
  return useQuery({
    queryKey: ["plugins"],
    enabled,
    queryFn: async () => {
      const { data, error } = await getPlugins();
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
      const { data, error } = await getPlugin({
        path: { id: id as string },
      });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
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
      toast.success("GitHub update approved and applied");
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
      toast.success("Plugin imported from GitHub");
    },
  });
}

export function useDiscoverGithubPluginMarketplace() {
  return useMutation({
    mutationFn: async (body: DiscoverGithubPluginMarketplaceBody) => {
      const { data, error } = await discoverGithubPluginMarketplace({ body });
      if (error) {
        return { data: null, errorMessage: getApiErrorMessage(error) };
      }
      return { data, errorMessage: null };
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
          ? "GitHub checks updated"
          : "GitHub checks disabled",
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
        queued ? "GitHub check queued" : "GitHub check already running",
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

export function useDeletePlugin(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await deletePlugin({ path: { id } });
      if (error) {
        handleApiError(error);
        return false;
      }
      return data?.success ?? false;
    },
    onSuccess: (deleted) => {
      if (!deleted) return;
      queryClient.removeQueries({ queryKey: ["plugins", id] });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      toast.success("Plugin deleted");
    },
  });
}

export function useBulkUpdatePluginVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      plugins: Array<{ id: string; name: string }>;
      scope: "personal" | "team" | "org";
      teamIds: string[];
      userIds: string[];
    }) => {
      const outcomes = await Promise.all(
        params.plugins.map(async (plugin) => {
          const { error } = await updatePlugin({
            path: { id: plugin.id },
            body: {
              scope: params.scope,
              teamIds: params.teamIds,
              userIds: params.userIds,
            },
          });
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
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      if (failed.length === 0)
        toast.success(`Updated ${succeeded.length} plugins`);
      else
        toast.warning(
          `Updated ${succeeded.length} plugins; ${failed.length} failed`,
        );
    },
  });
}

export function useBulkDeletePlugins() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (plugins: Array<{ id: string; name: string }>) => {
      const outcomes = await Promise.all(
        plugins.map(async (plugin) => {
          const { error } = await deletePlugin({ path: { id: plugin.id } });
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
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      if (failed.length === 0)
        toast.success(`Deleted ${succeeded.length} plugins`);
      else
        toast.warning(
          `Deleted ${succeeded.length} plugins; ${failed.length} failed`,
        );
    },
  });
}
