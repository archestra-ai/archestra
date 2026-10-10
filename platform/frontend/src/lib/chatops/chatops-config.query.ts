import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils/api";

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

export function useUnlinkTelegramAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } =
        await archestraApiSdk.unlinkTelegramChatOpsAccount();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) return;
      toast.success("Telegram account unlinked");
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

export function useSlackAgentBots() {
  return useQuery({
    queryKey: ["chatops", "slack-agent-bots"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listSlackAgentBots();
      throwOnApiError(error);
      return (
        data ?? {
          bots: [],
          canCreateApps: false,
          oneClickInstall: false,
          unassignedApp: null,
          workspaceName: null,
        }
      );
    },
  });
}

export function useUpdateSlackAgentBot(agentId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      body: NonNullable<archestraApiTypes.UpdateSlackAgentBotData["body"]>,
    ) => {
      if (!agentId) return null;
      const { data, error } = await archestraApiSdk.updateSlackAgentBot({
        path: { agentId },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      if (data?.success) {
        await archestraApiSdk
          .refreshChatOpsChannelDiscovery({ body: { provider: "slack" } })
          .catch(() => {});
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) return;
      toast.success("Slack bot connected");
      queryClient.invalidateQueries({
        queryKey: ["chatops", "slack-agent-bots"],
      });
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
  });
}

export function useDeleteSlackAgentBot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (agentId: string) => {
      const { data, error } = await archestraApiSdk.deleteSlackAgentBot({
        path: { agentId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) return;
      toast.success("Slack bot disconnected");
      queryClient.invalidateQueries({
        queryKey: ["chatops", "slack-agent-bots"],
      });
    },
  });
}

export function useSaveSlackAppConfigToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.UpdateSlackAppConfigTokenData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.updateSlackAppConfigToken({
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) return;
      toast.success("Slack apps can now be created automatically");
      reportSlackAppMigration(data.migrated);
      queryClient.invalidateQueries({
        queryKey: ["chatops", "slack-agent-bots"],
      });
    },
  });
}

/** Turn the channel-routed Slack app into one agent's bot. */
export function useConvertSlackAppToAgentBot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (agentId: string) => {
      const { data, error } = await archestraApiSdk.convertSlackAppToAgentBot({
        body: { agentId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data?.success) return;
      toast.success("The Slack app now answers as this agent");
      if (data.reinstallUrl) {
        const reinstallUrl = data.reinstallUrl;
        toast.warning("Reinstall the Slack app", {
          description: "Its permissions changed. Reinstall it from Slack.",
          action: {
            label: "Open",
            onClick: () => window.open(reinstallUrl, "_blank", "noopener"),
          },
        });
      }
      queryClient.invalidateQueries({
        queryKey: ["chatops", "slack-agent-bots"],
      });
      queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
    },
  });
}

/** Bring every connected Slack app's settings up to date again. */
export function useMigrateSlackApps() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await archestraApiSdk.migrateSlackApps();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (!data) return;
      reportSlackAppMigration(data.migrated);
      queryClient.invalidateQueries({
        queryKey: ["chatops", "slack-agent-bots"],
      });
    },
  });
}

function reportSlackAppMigration(
  results: archestraApiTypes.MigrateSlackAppsResponses["200"]["migrated"],
) {
  if (results.length === 0) return;
  const updated = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  if (updated.length > 0) {
    toast.success(
      `Updated ${updated.length} Slack ${updated.length === 1 ? "app" : "apps"} to the agent experience`,
    );
  }
  for (const result of updated.filter((r) => r.reinstallUrl)) {
    toast.warning(`Slack app ${result.appId} needs a reinstall`, {
      description: "Its permissions changed. Reinstall it from Slack.",
      action: {
        label: "Open",
        onClick: () => window.open(result.reinstallUrl, "_blank", "noopener"),
      },
    });
  }
  for (const result of failed) {
    toast.error(`Could not update Slack app ${result.appId}`, {
      description: result.error,
    });
  }
}

export function useCreateSlackAgentBotApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      body: archestraApiTypes.CreateSlackAgentBotAppData["body"];
    }) => {
      const { data, error } = await archestraApiSdk.createSlackAgentBotApp({
        path: { agentId: params.agentId },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["chatops", "slack-agent-bots"],
      });
    },
  });
}
