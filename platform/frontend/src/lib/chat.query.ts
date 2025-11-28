import { archestraApiSdk } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const {
  getChatConversations,
  getChatConversation,
  getChatAgentMcpTools,
  createChatConversation,
  updateChatConversation,
  deleteChatConversation,
} = archestraApiSdk;

export function useConversation(conversationId?: string) {
  return useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      const { data } = await getChatConversation({
        path: { id: conversationId },
      });
      return data ?? null;
    },
    enabled: !!conversationId,
    staleTime: 0, // Always refetch to ensure we have the latest messages
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't refetch when window gains focus
    retry: false, // Don't retry on error to avoid multiple 404s
    throwOnError: false,
  });
}

export function useConversations() {
  return useQuery({
    queryKey: ["conversations"],
    queryFn: async () => {
      const { data } = await getChatConversations();
      return data ?? [];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
    throwOnError: false,
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      promptId,
    }: {
      agentId: string;
      promptId?: string;
    }) => {
      const { data, error } = await createChatConversation({
        body: { agentId, promptId },
      });
      if (error) throw new Error("Failed to create conversation");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useUpdateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      title,
    }: {
      id: string;
      title?: string | null;
    }) => {
      const { data, error } = await updateChatConversation({
        path: { id },
        body: { title },
      });
      if (error) throw new Error("Failed to update conversation");
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({
        queryKey: ["conversation", variables.id],
      });
    },
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteChatConversation({
        path: { id },
      });
      if (error) throw new Error("Failed to delete conversation");
      return data;
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.removeQueries({ queryKey: ["conversation", deletedId] });
    },
  });
}

export function useChatProfileMcpTools(agentId: string | undefined) {
  return useQuery({
    queryKey: ["chat", "agents", agentId, "mcp-tools"],
    queryFn: async () => {
      if (!agentId) return [];
      const { data } = await getChatAgentMcpTools({
        path: { agentId },
      });
      return data ?? [];
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
    retry: false, // Don't retry on error
    throwOnError: false, // Don't throw errors to prevent crashes
  });
}
