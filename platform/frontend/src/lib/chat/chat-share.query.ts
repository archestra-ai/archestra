import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { callApi } from "@/lib/chat/api-call";

const {
  getConversationShare,
  shareConversation,
  unshareConversation,
  forkChatConversation,
  forkSharedConversation,
} = archestraApiSdk;

type ShareConversationMutationInput = {
  conversationId: string;
  suppressSuccessToast?: boolean;
} & NonNullable<archestraApiTypes.ShareConversationData["body"]>;

export function useConversationShare(conversationId: string | undefined) {
  return useQuery({
    queryKey: ["conversation-share", conversationId],
    queryFn: () => {
      if (!conversationId) return null;
      return callApi(
        () => getConversationShare({ path: { id: conversationId } }),
        null,
        { silentStatuses: [404] },
      );
    },
    enabled: !!conversationId,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useShareConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      visibility,
      teamIds,
      userIds,
      suppressSuccessToast: _suppressSuccessToast,
    }: ShareConversationMutationInput) =>
      callApi(
        () =>
          shareConversation({
            path: { id: conversationId },
            body: { visibility, teamIds, userIds },
          }),
        null,
      ),
    onSuccess: (data, { conversationId, suppressSuccessToast }) => {
      if (!data) return;
      queryClient.setQueryData(["conversation-share", conversationId], data);
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (!suppressSuccessToast) {
        toast.success("Chat visibility updated");
      }
    },
  });
}

export function useUnshareConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (conversationId: string) =>
      callApi(
        () => unshareConversation({ path: { id: conversationId } }),
        null,
      ),
    onSuccess: (_data, conversationId) => {
      queryClient.setQueryData(["conversation-share", conversationId], null);
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success("Chat sharing removed");
    },
  });
}

export function useForkSharedConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      shareId,
      agentId,
    }: {
      shareId: string;
      agentId: string;
    }) =>
      callApi(
        () => forkSharedConversation({ path: { shareId }, body: { agentId } }),
        null,
      ),
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (data.projectId) {
        queryClient.invalidateQueries({
          queryKey: ["projects", data.projectId, "conversations"],
        });
      }
    },
  });
}

export function useForkConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      agentId,
    }: {
      conversationId: string;
      agentId: string;
    }) =>
      callApi(
        () =>
          forkChatConversation({
            path: { id: conversationId },
            body: { agentId },
          }),
        null,
      ),
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (data.projectId) {
        queryClient.invalidateQueries({
          queryKey: ["projects", data.projectId, "conversations"],
        });
      }
    },
  });
}
