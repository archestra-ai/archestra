import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

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
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) {
        return;
      }
      toast.success("MS Teams configuration updated");
      queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
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
    mutationFn: async (body: {
      enabled?: boolean;
      botToken?: string;
      signingSecret?: string;
      appId?: string;
      connectionMode?: "webhook" | "socket";
      appLevelToken?: string;
    }) => {
      const { data, error } = await archestraApiSdk.updateSlackChatOpsConfig({
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) {
        return;
      }
      toast.success("Slack configuration updated");
      queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
    },
    onError: (error) => {
      console.error("Slack config update error:", error);
      toast.error("Failed to update Slack configuration");
    },
  });
}
