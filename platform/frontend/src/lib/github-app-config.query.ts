import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  runtimeCredentialsQueryKey,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";
import { handleApiError, throwOnApiError } from "@/lib/utils/api";

const {
  getGithubAppConfig,
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

/** GitHub consumers select from the shared organization credential list. */
export function useGithubAppConfigs() {
  const query = useRuntimeCredentials();
  return {
    ...query,
    data: query.data?.filter(
      (credential) =>
        credential.allowOrganization && credential.kind === "github_app",
    ),
  };
}

export function useGithubAppConfig(id: string | undefined) {
  return useQuery({
    queryKey: [...githubAppConfigKeys.all, "detail", id],
    queryFn: async () => {
      if (!id) return null;
      const response = await getGithubAppConfig({ path: { id } });
      throwOnApiError(response.error, {
        allowNotFound: true,
        toastOnError: false,
      });
      return response.data ?? null;
    },
    enabled: !!id,
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
      queryClient.invalidateQueries({ queryKey: runtimeCredentialsQueryKey });
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
      queryClient.invalidateQueries({ queryKey: runtimeCredentialsQueryKey });
      queryClient.invalidateQueries({ queryKey: githubAppConfigKeys.all });
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
      queryClient.invalidateQueries({ queryKey: runtimeCredentialsQueryKey });
      queryClient.invalidateQueries({ queryKey: githubAppConfigKeys.all });
      toast.success("GitHub App configuration deleted");
    },
  });
}
