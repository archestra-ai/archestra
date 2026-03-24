import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

export function useUpdateChatOpsConfigInQuickstart() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.UpdateChatOpsConfigInQuickstartData["body"],
    ) => {
      const { data, error } =
        await archestraApiSdk.updateChatOpsConfigInQuickstart({
          body,
        });
      if (error) {
        handleApiError(error);
        return null;
      }
      if (data?.success) {
        await archestraApiSdk
          .refreshChatOpsChannelDiscovery({ body: { provider: "ms-teams" } })
          .catch(() => {});
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) {
        return;
      }
      toast.success("MS Teams configuration updated");
      queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
    onError: (error) => {
      // Keep a defensive fallback for unexpected runtime errors.
      console.error("ChatOps config update error:", error);
      toast.error("Failed to update MS Teams configuration");
    },
  });
}

export function useUpdateSlackChatOpsConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      body: NonNullable<archestraApiTypes.UpdateSlackChatOpsConfigData["body"]>,
    ) => {
      const { data, error } = await archestraApiSdk.updateSlackChatOpsConfig({
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      if (data?.success) {
        // Trigger channel discovery (awaits completion on backend)
        // so channels are available when the UI refreshes bindings
        await archestraApiSdk
          .refreshChatOpsChannelDiscovery({ body: { provider: "slack" } })
          .catch(() => {});
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) {
        return;
      }
      toast.success("Slack configuration updated");
      queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
    onError: (error) => {
      console.error("Slack config update error:", error);
      toast.error("Failed to update Slack configuration");
    },
  });
}
