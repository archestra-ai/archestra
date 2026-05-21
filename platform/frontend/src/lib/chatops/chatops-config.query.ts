import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export function useWhatsAppQrCode({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["chatops", "whatsapp", "qr"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getWhatsAppQrCode();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    enabled,
    refetchInterval: false,
  });
}

export function useUpdateWhatsAppChatOpsConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      body: NonNullable<archestraApiTypes.UpdateWhatsAppChatOpsConfigData["body"]>,
    ) => {
      const { data, error } = await archestraApiSdk.updateWhatsAppChatOpsConfig({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) return;
      toast.success("WhatsApp configuration updated");
      queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
      queryClient.invalidateQueries({ queryKey: ["chatops", "whatsapp", "qr"] });
    },
    onError: () => {
      toast.error("Failed to update WhatsApp configuration");
    },
  });
}

export function useDisconnectWhatsApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await archestraApiSdk.disconnectWhatsApp();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: () => {
      toast.success("WhatsApp disconnected");
      queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
      queryClient.invalidateQueries({ queryKey: ["chatops", "whatsapp", "qr"] });
    },
    onError: () => {
      toast.error("Failed to disconnect WhatsApp");
    },
  });
}

export function useDeleteWhatsAppPhoneMapping() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (phone: string) => {
      const { data, error } = await archestraApiSdk.deleteWhatsAppPhoneMapping({ path: { phone } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chatops", "whatsapp", "qr"] });
    },
    onError: () => {
      toast.error("Failed to remove phone mapping");
    },
  });
}

export function useSwitchWhatsAppAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await archestraApiSdk.switchWhatsAppAccount();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: () => {
      toast.success("WhatsApp session cleared — scan a new QR to connect a different account");
      queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
      queryClient.invalidateQueries({ queryKey: ["chatops", "whatsapp", "qr"] });
    },
    onError: () => {
      toast.error("Failed to switch WhatsApp account");
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
