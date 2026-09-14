import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  runtimeCredentialsQueryKey,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";
import { handleApiError } from "@/lib/utils";

const { createGithubPat, updateGithubPat, deleteGithubPat } = archestraApiSdk;

export type GithubPat =
  archestraApiTypes.ListGithubPatsResponses["200"][number];

export const githubPatKeys = {
  all: ["github-pats"] as const,
  lists: () => [...githubPatKeys.all, "list"] as const,
};

/** GitHub consumers select from the shared organization credential list. */
export function useGithubPats() {
  const query = useRuntimeCredentials();
  return {
    ...query,
    data: query.data?.filter(
      (credential) =>
        credential.allowOrganization && credential.kind === "secret",
    ),
  };
}

export function useCreateGithubPat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: archestraApiTypes.CreateGithubPatData["body"]) => {
      const response = await createGithubPat({ body: data });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: runtimeCredentialsQueryKey });
      queryClient.invalidateQueries({ queryKey: githubPatKeys.lists() });
      toast.success("GitHub token saved");
    },
  });
}

export function useUpdateGithubPat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: archestraApiTypes.UpdateGithubPatData["body"];
    }) => {
      const response = await updateGithubPat({ path: { id }, body: data });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: runtimeCredentialsQueryKey });
      queryClient.invalidateQueries({ queryKey: githubPatKeys.lists() });
      toast.success("GitHub token updated");
    },
  });
}

export function useDeleteGithubPat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deleteGithubPat({ path: { id } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: runtimeCredentialsQueryKey });
      queryClient.invalidateQueries({ queryKey: githubPatKeys.lists() });
      toast.success("GitHub token deleted");
    },
  });
}
