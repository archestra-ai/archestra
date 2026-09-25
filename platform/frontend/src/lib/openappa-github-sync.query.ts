import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  appaGithubSyncQueryKey,
  invalidatePolicyViews,
} from "@/lib/openappa-policy-views";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export function useAppaGithubSync() {
  return useQuery({
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
    onSettled: () => invalidatePolicyViews(client),
    onSuccess: (_data, body) => {
      toast.success(
        body.action === "sync"
          ? "Sync queued"
          : body.action === "disconnect"
            ? "Sync stopped. The last accepted policy is kept."
            : "Sync schedule updated",
      );
    },
  });
}
