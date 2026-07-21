import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const { listGithubPats, createGithubPat, updateGithubPat, deleteGithubPat } =
  archestraApiSdk;

export type GithubPat =
  archestraApiTypes.ListGithubPatsResponses["200"][number];

export const githubPatKeys = {
  all: ["github-pats"] as const,
  lists: () => [...githubPatKeys.all, "list"] as const,
};

/**
 * List the organization's stored GitHub tokens. Gated on read permission so
 * callers without access (e.g. the import dialog for a plain member) don't
 * fire a request that would 403. Token values are never returned.
 */
export function useGithubPats() {
  const isAuthenticated = useIsAuthenticated();
  const { data: canRead } = useHasPermissions({ githubAppConfig: ["read"] });
  return useQuery({
    queryKey: githubPatKeys.lists(),
    queryFn: async () => {
      const response = await listGithubPats();
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? [];
    },
    enabled: isAuthenticated && !!canRead,
  });
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
      queryClient.invalidateQueries({ queryKey: githubPatKeys.lists() });
      toast.success("GitHub token deleted");
    },
  });
}
