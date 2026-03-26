import { archestraApiSdk } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const {
  getConversationShare,
  shareConversation,
  unshareConversation,
  getSharedConversation,
  forkSharedConversation,
} = archestraApiSdk;

export function useConversationShare(conversationId: string | undefined) {
  return useQuery({
    queryKey: ["conversation-share", conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      const { data, error } = await getConversationShare({
        path: { id: conversationId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!conversationId,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useShareConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      const { data, error } = await shareConversation({
        path: { id: conversationId },
        body: { visibility: "organization" },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, conversationId) => {
      if (!data) return;
      queryClient.setQueryData(["conversation-share", conversationId], data);
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
    },
  });
}

export function useSharedConversation(shareId: string | undefined) {
  return useQuery({
    queryKey: ["shared-conversation", shareId],
    queryFn: async () => {
      if (!shareId) return null;
      const { data, error } = await getSharedConversation({
        path: { shareId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!shareId,
    staleTime: 0,
    gcTime: 10 * 60 * 1000,
    retry: false,
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
