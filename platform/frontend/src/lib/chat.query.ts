import {
  archestraApiSdk,
  isBrowserMcpTool,
  type SupportedProvider,
} from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const {
  getChatConversations,
  getChatConversation,
  getChatAgentMcpTools,
  createChatConversation,
  updateChatConversation,
  deleteChatConversation,
  generateChatConversationTitle,
  getConversationEnabledTools,
  updateConversationEnabledTools,
  deleteConversationEnabledTools,
  getAgentTools,
  getPromptTools,
} = archestraApiSdk;

export function useConversation(conversationId?: string) {
  return useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      const { data, error } = await getChatConversation({
        path: { id: conversationId },
      });
      if (error) throw new Error("Failed to fetch conversation");
      return data;
    },
    enabled: !!conversationId,
    staleTime: 0, // Always refetch to ensure we have the latest messages
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't refetch when window gains focus
    retry: false, // Don't retry on error to avoid multiple 404s
  });
}

export function useConversations() {
  return useQuery({
    queryKey: ["conversations"],
    queryFn: async () => {
      const { data, error } = await getChatConversations();
      if (error) throw new Error("Failed to fetch conversations");
      return data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      promptId,
      selectedModel,
      selectedProvider,
      chatApiKeyId,
    }: {
      agentId: string;
      promptId?: string;
      selectedModel?: string;
      selectedProvider?: SupportedProvider;
      chatApiKeyId?: string | null;
    }) => {
      const { data, error } = await createChatConversation({
        body: {
          agentId,
          promptId,
          selectedModel,
          selectedProvider,
          chatApiKeyId: chatApiKeyId ?? undefined,
        },
      });
      if (error) throw new Error("Failed to create conversation");
      return data;
    },
    onSuccess: (newConversation) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // Immediately populate the individual conversation cache to avoid loading state
      if (newConversation) {
        queryClient.setQueryData(
          ["conversation", newConversation.id],
          newConversation,
        );
      }
    },
  });
}

export function useUpdateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      title,
      selectedModel,
      selectedProvider,
      chatApiKeyId,
      agentId,
    }: {
      id: string;
      title?: string | null;
      selectedModel?: string;
      selectedProvider?: SupportedProvider;
      chatApiKeyId?: string | null;
      agentId?: string;
    }) => {
      const { data, error } = await updateChatConversation({
        path: { id },
        body: { title, selectedModel, selectedProvider, chatApiKeyId, agentId },
      });
      if (error) throw new Error("Failed to update conversation");
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({
        queryKey: ["conversation", variables.id],
      });
      if (variables.chatApiKeyId) {
        queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      }
    },
    onError: (error) => {
      toast.error(
        `Failed to update conversation: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
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
      toast.success("Conversation deleted");
    },
  });
}

export function useGenerateConversationTitle() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      regenerate = false,
    }: {
      id: string;
      regenerate?: boolean;
    }) => {
      const { data, error } = await generateChatConversationTitle({
        path: { id },
        body: { regenerate },
      });
      if (error) throw new Error("Failed to generate conversation title");
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

export function useChatProfileMcpTools(agentId: string | undefined) {
  return useQuery({
    queryKey: ["chat", "agents", agentId, "mcp-tools"],
    queryFn: async () => {
      if (!agentId) return [];
      const { data, error } = await getChatAgentMcpTools({
        path: { agentId },
      });
      if (error) throw new Error("Failed to fetch MCP tools");
      return data;
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
  });
}

/**
 * Get enabled tools for a conversation
 * Returns { hasCustomSelection: boolean, enabledToolIds: string[] }
 * Empty enabledToolIds with hasCustomSelection=false means all tools enabled (default)
 */
export function useConversationEnabledTools(
  conversationId: string | undefined,
) {
  return useQuery({
    queryKey: ["conversation", conversationId, "enabled-tools"],
    queryFn: async () => {
      if (!conversationId) return null;
      const { data, error } = await getConversationEnabledTools({
        path: { id: conversationId },
      });
      if (error) throw new Error("Failed to fetch enabled tools");
      return data;
    },
    enabled: !!conversationId,
    staleTime: 30 * 1000, // 30 seconds
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Update enabled tools for a conversation
 * Pass toolIds to set specific enabled tools
 */
export function useUpdateConversationEnabledTools() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      toolIds,
    }: {
      conversationId: string;
      toolIds: string[];
    }) => {
      const { data, error } = await updateConversationEnabledTools({
        path: { id: conversationId },
        body: { toolIds },
      });
      if (error) throw new Error("Failed to update enabled tools");
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", variables.conversationId, "enabled-tools"],
      });
    },
  });
}

/**
 * Clear custom tool selection for a conversation (revert to all tools enabled)
 */
export function useClearConversationEnabledTools() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      const { data, error } = await deleteConversationEnabledTools({
        path: { id: conversationId },
      });
      if (error) throw new Error("Failed to clear enabled tools");
      return data;
    },
    onSuccess: (_, conversationId) => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId, "enabled-tools"],
      });
    },
  });
}

/**
 * Get profile tools with IDs (for the manage tools dialog)
 * Returns full tool objects including IDs needed for enabled tools junction table
 */
export function useProfileToolsWithIds(agentId: string | undefined) {
  return useQuery({
    queryKey: ["agents", agentId, "tools", "mcp-only"],
    queryFn: async () => {
      if (!agentId) return [];
      const { data, error } = await getAgentTools({
        path: { agentId },
        query: { excludeLlmProxyOrigin: true },
      });
      if (error) throw new Error("Failed to fetch profile tools");
      return data;
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
  });
}

/**
 * Get agent delegation tools for a prompt
 * Returns tools created from prompt agents with real database IDs
 */
export function usePromptTools(promptId: string | undefined) {
  return useQuery({
    queryKey: ["prompts", promptId, "tools"],
    queryFn: async () => {
      if (!promptId) return [];
      const { data, error } = await getPromptTools({
        path: { id: promptId },
      });
      if (error) throw new Error("Failed to fetch prompt tools");
      return data;
    },
    enabled: !!promptId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
  });
}

export function useHasPlaywrightMcpTools(agentId: string | undefined) {
  const toolsQuery = useChatProfileMcpTools(agentId);

  return (
    toolsQuery.data?.some((tool) => {
      const toolName = tool.name;
      return typeof toolName === "string" && isBrowserMcpTool(toolName);
    }) ?? false
  );
}
