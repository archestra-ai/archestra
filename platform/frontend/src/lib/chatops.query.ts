import { archestraApiSdk } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

export function useChatOpsStatus() {
  return useQuery({
    queryKey: ["chatops", "status"],
    queryFn: async () => {
      const response = await archestraApiSdk.getChatOpsStatus();
      return response.data?.providers || [];
    },
  });
}

export function useChatOpsBindings() {
  return useQuery({
    queryKey: ["chatops", "bindings"],
    queryFn: async () => {
      const response = await archestraApiSdk.listChatOpsBindings();
      return response.data ?? [];
    },
  });
}

export function useUpdateChatOpsBinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; agentId: string | null }) => {
      const { data, error } = await archestraApiSdk.updateChatOpsBinding({
        path: { id: params.id },
        body: { agentId: params.agentId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Binding updated");
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
  });
}

export function useDeleteChatOpsBinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await archestraApiSdk.deleteChatOpsBinding({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: () => {
      toast.success("Binding deleted");
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
  });
}

export function useRefreshChatOpsChannelDiscovery() {
  return useMutation({
    mutationFn: async (provider: string) => {
      const { error } = await archestraApiSdk.refreshChatOpsChannelDiscovery({
        body: { provider: provider as "ms-teams" },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
  });
}
