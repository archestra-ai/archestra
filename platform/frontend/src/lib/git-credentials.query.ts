import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { runtimeCredentialsQueryKey } from "@/lib/runtime-credentials.query";
import { throwOnApiError, toApiError } from "@/lib/utils/api";

export type GitCredential =
  archestraApiTypes.ListGitCredentialsResponses["200"][number];

/** The organization's GitHub Apps and GitLab tokens, for any Git setup. */
export function useGitCredentials(enabled = true) {
  return useQuery({
    enabled,
    queryKey: gitCredentialsQueryKey,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listGitCredentials();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

/**
 * Save a GitLab token. GitLab checks it first, so a bad token or scope comes
 * back as an error the form shows inline rather than as a toast.
 */
export function useCreateGitlabToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateGitlabTokenData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.createGitlabToken({
        body,
      });
      if (error) throw toApiError(error);
      return data;
    },
    onSuccess: (created) => {
      if (created)
        client.setQueryData<GitCredential[]>(gitCredentialsQueryKey, (list) =>
          list ? [...list, created] : [created],
        );
      client.invalidateQueries({ queryKey: gitCredentialsQueryKey });
      client.invalidateQueries({ queryKey: runtimeCredentialsQueryKey });
      toast.success("GitLab token saved");
    },
  });
}

/** Repositories (GitHub) or projects (GitLab) a credential can read. */
export function useGitCredentialRepositories(params: {
  credentialId: string | null;
  search: string;
}) {
  const search = params.search.trim();
  return useQuery({
    enabled: !!params.credentialId,
    queryKey: [
      ...gitCredentialsQueryKey,
      params.credentialId,
      "repositories",
      search,
    ],
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.listGitCredentialRepositories({
          path: { id: params.credentialId as string },
          query: search ? { search } : undefined,
        });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    // Keep the list on screen while a new search loads.
    placeholderData: keepPreviousData,
  });
}

/** Where a credential can create a repository; "" is the GitLab token owner. */
export function useGitCredentialNamespaces(credentialId: string | null) {
  return useQuery({
    enabled: !!credentialId,
    queryKey: [...gitCredentialsQueryKey, credentialId, "namespaces"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listGitCredentialNamespaces(
        { path: { id: credentialId as string } },
      );
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

const gitCredentialsQueryKey = ["git-credentials"] as const;
