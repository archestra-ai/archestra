import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  appaGithubSyncQueryKey,
  invalidatePolicyViews,
} from "@/lib/openappa-policy-views";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export function useAppaGithubSync() {
  const { data: canRead } = useHasPermissions({
    organizationSettings: ["read"],
  });
  return useQuery({
    enabled: canRead === true,
    queryKey: appaGithubSyncQueryKey,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getAppaGithubSync();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    refetchInterval: 10000,
  });
}
export function useConfigureAppaGithubSync() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.ConfigureAppaGithubSyncData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.configureAppaGithubSync({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("GitHub source saved. First sync queued.");
    },
    // Syncing hands the text to the repository: every view of it follows.
    onSettled: () => invalidatePolicyViews(client),
  });
}
export function useCreateAppaGithubRepository() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateAppaGithubRepositoryData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.createAppaGithubRepository({
        body,
      });
      if (error) {
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data) =>
      toast.success(
        data?.source?.setupPullRequestNumber
          ? "Repository connected. Merge the initial policy pull request to finish setup."
          : "Repository connected with your current policy.",
      ),
    onSettled: () => invalidatePolicyViews(client),
  });
}
export function useUpdateAppaGithubSync() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.UpdateAppaGithubSyncData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.updateAppaGithubSync({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    // Whether a setup pull request was pending when the sync was asked for:
    // the row forgets its number once the merge imports the policy.
    onMutate: () => ({
      awaitingMerge: !!client.getQueryData<
        archestraApiTypes.GetAppaGithubSyncResponses["200"]
      >(appaGithubSyncQueryKey)?.source?.setupPullRequestNumber,
    }),
    onSettled: () => invalidatePolicyViews(client),
    onSuccess: (data, body, context) => {
      if (body.action === "sync" && data?.source?.lastSyncError) return;
      if (body.action === "sync" && data?.source?.setupPullRequestNumber) {
        toast.info(
          "Not merged yet. The initial policy pull request is still open.",
        );
        return;
      }
      if (body.action === "sync" && context.awaitingMerge) {
        toast.success("Initial policy merged. Policy synced from GitHub.");
        return;
      }
      toast.success(
        body.action === "sync"
          ? "Sync complete"
          : body.action === "disconnect"
            ? "Sync stopped. The last accepted policy is kept."
            : "Sync schedule updated",
      );
    },
  });
}
