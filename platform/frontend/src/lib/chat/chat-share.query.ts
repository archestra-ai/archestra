import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  getConversationShare,
  shareConversation,
  unshareConversation,
  forkSharedConversation,
} = archestraApiSdk;

type ShareConversationMutationInput = {
  conversationId: string;
} & NonNullable<archestraApiTypes.ShareConversationData["body"]>;

export function useConversationShare(conversationId: string | undefined) {
  return useQuery({
    queryKey: ["conversation-share", conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      const response = await getConversationShare({
        path: { id: conversationId },
      });
      if (response.error) {
        if (response.response.status !== 404) {
          handleApiError(response.error);
        }
        return null;
      }
      return response.data;
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
    }: ShareConversationMutationInput) => {
      const { data, error } = await shareConversation({
        path: { id: conversationId },
        body: { visibility, teamIds, userIds },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, { conversationId }) => {
      if (!data) return;
      queryClient.setQueryData(["conversation-share", conversationId], data);
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success("Chat visibility updated");
    },
  });
}

export function useUnshareConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      const { data, error } = await unshareConversation({
        path: { id: conversationId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
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
    }) => {
      const { data, error } = await forkSharedConversation({
        path: { shareId },
        body: { agentId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
