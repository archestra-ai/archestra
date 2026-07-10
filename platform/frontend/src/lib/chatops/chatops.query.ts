import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils";

export function useChatOpsStatus() {
  return useQuery({
    queryKey: ["chatops", "status"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getChatOpsStatus();
      throwOnApiError(error);
      return data?.providers || [];
    },
  });
}

export function useChatOpsBindings(
  params: NonNullable<archestraApiTypes.ListChatOpsBindingsData["query"]>,
) {
  return useQuery({
    queryKey: ["chatops", "bindings", params],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listChatOpsBindings({
        query: {
          provider: params.provider,
          limit: params.limit ?? 20,
          offset: params.offset ?? 0,
          sortBy: params.sortBy,
          sortDirection: params.sortDirection,
          search: params.search || undefined,
          workspaceId: params.workspaceId || undefined,
          status: params.status,
        },
      });
      // Screen renders its own QueryLoadError panel; don't also toast.
      throwOnApiError(error, { toastOnError: false });
      return data;
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
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Channels updated");
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
  });
}

export function useBulkUpdateChatOpsBindings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { ids: string[]; agentId: string | null }) => {
      const { data, error } = await archestraApiSdk.bulkUpdateChatOpsBindings({
        body: { ids: params.ids, agentId: params.agentId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success(
        `${data.length} channel${data.length === 1 ? "" : "s"} updated`,
      );
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
  });
}

export function useCreateChatOpsDmBinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      provider: "ms-teams" | "slack" | "telegram";
      agentId: string | null;
    }) => {
      const { data, error } = await archestraApiSdk.createChatOpsDmBinding({
        body: params,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Direct message channel updated");
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
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Binding deleted");
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
  });
}

export function useRefreshChatOpsChannelDiscovery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (provider: string) => {
      const { error } = await archestraApiSdk.refreshChatOpsChannelDiscovery({
        body: { provider: provider as "ms-teams" | "slack" },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
    },
  });
}
