import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

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
          botId: params.botId,
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

/**
 * Load every channel visible to the current user for the agent assignment
 * picker. The public list endpoint is capped at 100 rows, so the picker walks
 * every page instead of silently making channels past the first page
 * impossible to assign.
 */
export function useAllChatOpsBindings() {
  const limit = 100;

  return useInfiniteQuery({
    queryKey: ["chatops", "bindings", "all"],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await archestraApiSdk.listChatOpsBindings({
        query: {
          limit,
          offset: pageParam,
          sortBy: "channelName",
          sortDirection: "asc",
        },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    getNextPageParam: (lastPage) =>
      lastPage?.pagination.hasNext
        ? lastPage.pagination.currentPage * limit
        : undefined,
    select: (data) => ({
      ...data,
      bindings: data.pages.flatMap((page) => page?.data ?? []),
    }),
  });
}

export function useApplyChatOpsBindingPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.ApplyChatOpsBindingPlanData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.applyChatOpsBindingPlan({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Channel changes saved");
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
