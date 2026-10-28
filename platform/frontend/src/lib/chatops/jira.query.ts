import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export function useJiraChatOpsConfig() {
  return useQuery({
    queryKey: ["chatops", "jira", "config"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getJiraChatOpsConfig();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useUpdateJiraChatOpsConfig() {
  const saved = useJiraSaved("Jira site configuration saved");
  return useMutation({
    gcTime: 0,
    mutationFn: async (
      body: archestraApiTypes.UpdateJiraChatOpsConfigData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.updateJiraChatOpsConfig({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: saved,
  });
}

export function useCreateJiraChatOpsBot() {
  const saved = useJiraSaved("Jira identity verified and connected");
  return useMutation({
    gcTime: 0,
    mutationFn: async (
      body: archestraApiTypes.CreateJiraChatOpsBotData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.createJiraChatOpsBot({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: saved,
  });
}

export function useUpdateJiraChatOpsBot(botId: string) {
  const saved = useJiraSaved("Jira bot updated");
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.UpdateJiraChatOpsBotData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.updateJiraChatOpsBot({
        path: { botId },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: saved,
  });
}

export function useDeleteJiraChatOpsBot() {
  const saved = useJiraSaved("Jira bot disconnected");
  return useMutation({
    mutationFn: async (botId: string) => {
      const { data, error } = await archestraApiSdk.deleteJiraChatOpsBot({
        path: { botId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: saved,
  });
}

export function useJiraChatOpsProjects(botId: string) {
  return useQuery({
    queryKey: ["chatops", "jira", "projects", botId],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listJiraChatOpsProjects({
        path: { botId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: !!botId,
  });
}

export function useCreateJiraChatOpsBinding(botId: string) {
  const saved = useJiraSaved("Jira project connected");
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateJiraChatOpsBindingData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.createJiraChatOpsBinding({
        path: { botId },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: saved,
  });
}

function useJiraSaved(message: string) {
  const queryClient = useQueryClient();
  return () => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: ["chatops", "jira"] });
    void queryClient.invalidateQueries({ queryKey: ["chatops", "status"] });
    void queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
  };
}
