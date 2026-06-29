import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const {
  listGithubAppConfigs,
  createGithubAppConfig,
  updateGithubAppConfig,
  deleteGithubAppConfig,
} = archestraApiSdk;

export type GithubAppConfig =
  archestraApiTypes.ListGithubAppConfigsResponses["200"][number];

export const githubAppConfigKeys = {
  all: ["github-app-configs"] as const,
  lists: () => [...githubAppConfigKeys.all, "list"] as const,
};

/**
 * List the organization's GitHub App configurations. Gated on read permission
 * so callers without access (e.g. the connector dialog for a plain member)
 * don't fire a request that would 403.
 */
export function useGithubAppConfigs() {
  const isAuthenticated = useIsAuthenticated();
  const { data: canRead } = useHasPermissions({ githubAppConfig: ["read"] });
  return useQuery({
    queryKey: githubAppConfigKeys.lists(),
    queryFn: async () => {
      const response = await listGithubAppConfigs();
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? [];
    },
    enabled: isAuthenticated && !!canRead,
  });
}

export function useCreateGithubAppConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateGithubAppConfigData["body"],
    ) => {
      const response = await createGithubAppConfig({ body: data });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: githubAppConfigKeys.lists() });
      toast.success("GitHub App configuration created");
    },
  });
}

export function useUpdateGithubAppConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: archestraApiTypes.UpdateGithubAppConfigData["body"];
    }) => {
      const response = await updateGithubAppConfig({
        path: { id },
        body: data,
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: githubAppConfigKeys.lists() });
      toast.success("GitHub App configuration updated");
    },
  });
}

export function useDeleteGithubAppConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deleteGithubAppConfig({ path: { id } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: githubAppConfigKeys.lists() });
      toast.success("GitHub App configuration deleted");
    },
  });
}
