import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils";

export function useNgrokConfig(enabled = true) {
  return useQuery({
    queryKey: ["chatops", "ngrok-config"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getNgrokConfig();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled,
  });
}

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

export function useConnectNgrok() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: archestraApiTypes.ConnectNgrokData["body"]) => {
      const { data, error } = await archestraApiSdk.connectNgrok({ body });
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
      toast.success(
        data.domain
          ? `ngrok tunnel connected at ${data.domain}`
          : "ngrok tunnel connected",
      );
      // Refresh config so the resolved ngrok domain (and setup status) update.
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["chatops", "ngrok-config"] });
    },
    onError: (error) => {
      console.error("ngrok connect error:", error);
      toast.error("Failed to connect ngrok tunnel");
    },
  });
}

export function useDisconnectNgrok() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await archestraApiSdk.disconnectNgrok();
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
      toast.success("ngrok tunnel stopped");
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["chatops", "ngrok-config"] });
    },
    onError: (error) => {
      console.error("ngrok disconnect error:", error);
      toast.error("Failed to stop ngrok tunnel");
    },
  });
}

export function useUpdateTelegramChatOpsConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      body: NonNullable<
        archestraApiTypes.UpdateTelegramChatOpsConfigData["body"]
      >,
    ) => {
      const { data, error } = await archestraApiSdk.updateTelegramChatOpsConfig(
        { body },
      );
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
      toast.success("Telegram configuration updated");
      queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
    onError: (error) => {
      console.error("Telegram config update error:", error);
      toast.error("Failed to update Telegram configuration");
    },
  });
}

export function useGenerateTelegramLinkCode() {
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await archestraApiSdk.generateTelegramLinkCode();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
  });
}

export function useLinkTelegramAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (code: string) => {
      const { data, error } = await archestraApiSdk.linkTelegramChatOpsAccount({
        body: { code },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) return;
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
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
