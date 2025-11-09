import { archestraApiSdk } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const { getChatConversations, createChatConversation, deleteChatConversation } =
  archestraApiSdk;

export interface ConversationWithAgent {
  id: string;
  title: string | null;
  selectedModel: string;
  userId: string;
  organizationId: string;
  agentId: string;
  agent: {
    id: string;
    name: string;
  };
  createdAt: string;
  updatedAt: string;
}

export function useConversations() {
  return useQuery<ConversationWithAgent[]>({
    queryKey: ["conversations"],
    queryFn: async () => {
      const response = await getChatConversations();
      if (response.error) throw new Error("Failed to fetch conversations");
      return response.data as ConversationWithAgent[];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (agentId: string) => {
      const response = await createChatConversation({
        body: { agentId },
      });
      if (response.error) throw new Error("Failed to create conversation");
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deleteChatConversation({
        path: { id },
      });
      if (response.error) throw new Error("Failed to delete conversation");
      return response.data;
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.removeQueries({ queryKey: ["conversation", deletedId] });
    },
  });
}
