import {
  archestraApiSdk,
  PLAYWRIGHT_MCP_CATALOG_ID,
  PLAYWRIGHT_MCP_SERVER_NAME,
  type SupportedProvider,
} from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { invalidateToolAssignmentQueries } from "./agent-tools.hook";
import { authClient } from "./clients/auth/auth-client";
import { useMcpServers } from "./mcp-server.query";
import { handleApiError } from "./utils";

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
  installMcpServer,
  reinstallMcpServer,
  getMcpServer,
  getInternalMcpCatalogTools,
  bulkAssignTools,
  stopChatStream,
} = archestraApiSdk;

export function useConversation(conversationId?: string) {
  return useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      const response = await getChatConversation({
        path: { id: conversationId },
      });
      // Return null for any error - handled gracefully by UI
      if (response.error) {
        const status = response.response.status;
        // Only show toast for unexpected errors (not 400/404 which are handled gracefully)
        if (status !== 400 && status !== 404) {
          handleApiError(response.error);
        }
        return null;
      }
      return response.data;
    },
    enabled: !!conversationId,
    staleTime: 0, // Always refetch to ensure we have the latest messages
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't refetch when window gains focus
    retry: false, // Don't retry on error to avoid multiple 404s
  });
}

export function useConversations({
  enabled = true,
  search,
}: {
  enabled?: boolean;
  search?: string;
}) {
  return useQuery({
    queryKey: ["conversations", search],
    queryFn: async () => {
      if (!enabled) return [];
      const trimmedSearch = search?.trim();

      const { data, error } = await getChatConversations({
        query: trimmedSearch ? { search: trimmedSearch } : undefined,
      });

      if (error) {
        handleApiError(error);
        return [];
      }
      return data;
    },
    staleTime: search ? 0 : 2_000, // No stale time for searches, 2 seconds otherwise
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      selectedModel,
      selectedProvider,
      chatApiKeyId,
    }: {
      agentId: string;
      selectedModel?: string;
      selectedProvider?: SupportedProvider;
      chatApiKeyId?: string | null;
    }) => {
      const { data, error } = await createChatConversation({
        body: {
          agentId,
          selectedModel,
          selectedProvider,
          chatApiKeyId: chatApiKeyId ?? undefined,
        },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
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
      if (error) {
        handleApiError(error);
        return null;
      }
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
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteChatConversation({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.removeQueries({ queryKey: ["conversation", deletedId] });
      toast.success("Conversation deleted");
    },
  });
}

export function useStopChatStream() {
  return useMutation({
    mutationFn: async (conversationId: string) => {
      const { data, error } = await stopChatStream({
        path: { id: conversationId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
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
      if (error) {
        handleApiError(error);
        return null;
      }
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
      if (error) {
        handleApiError(error);
        return [];
      }
      return data;
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
  });
}

/**
 * Fetch enabled tools for a conversation (non-hook version for use in callbacks)
 * Returns { hasCustomSelection: boolean, enabledToolIds: string[] } or null on error
 */
export async function fetchConversationEnabledTools(conversationId: string) {
  const { data, error } = await getConversationEnabledTools({
    path: { id: conversationId },
  });
  if (error) return null;
  return data;
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
      const data = await fetchConversationEnabledTools(conversationId);
      if (!data) {
        handleApiError({
          error: new Error("Failed to fetch enabled tools"),
        });
        return null;
      }
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
      if (error) {
        handleApiError(error);
        return null;
      }
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
      if (error) {
        handleApiError(error);
        return null;
      }
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
/**
 * Fetch MCP tools for an agent (raw function for use with useQueries).
 */
export async function fetchAgentMcpTools(agentId: string | undefined) {
  if (!agentId) return [];
  const { data, error } = await getAgentTools({
    path: { agentId },
    query: { excludeLlmProxyOrigin: true },
  });
  if (error) {
    handleApiError(error);
    return [];
  }
  return data;
}

export function useProfileToolsWithIds(agentId: string | undefined) {
  return useQuery({
    queryKey: ["agents", agentId, "tools", "mcp-only"],
    queryFn: () => fetchAgentMcpTools(agentId),
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
  });
}

/**
 * Get delegation tools for an internal agent
 * Returns delegation tools (tools that delegate to other agents) assigned to this agent
 */
export function useAgentDelegationTools(agentId: string | undefined) {
  return useQuery({
    queryKey: ["agents", agentId, "delegation-tools"],
    queryFn: async () => {
      if (!agentId) return [];
      const { data, error } = await getAgentTools({
        path: { agentId },
        query: { excludeLlmProxyOrigin: true },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      // Filter for delegation tools (tools with name starting with "delegate_to_")
      return (data ?? []).filter((tool) =>
        tool.name.startsWith("delegate_to_"),
      );
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
  });
}

/**
 * Install browser preview (Playwright) for the current user with polling for completion.
 * Creates a personal Playwright server if one doesn't exist.
 * Polls for installation status since local servers are deployed asynchronously to K8s.
 */
function useBrowserInstallation(onInstallComplete?: (agentId: string) => void) {
  const [installingServerId, setInstallingServerId] = useState<string | null>(
    null,
  );
  const [installingAgentId, setInstallingAgentId] = useState<string | null>(
    null,
  );
  const queryClient = useQueryClient();
  const onInstallCompleteRef = useRef(onInstallComplete);
  onInstallCompleteRef.current = onInstallComplete;

  const installMutation = useMutation({
    mutationFn: async (agentId: string) => {
      const { data, error } = await installMcpServer({
        body: {
          name: PLAYWRIGHT_MCP_SERVER_NAME,
          catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
          agentIds: [agentId],
        },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, agentId) => {
      if (data?.id) {
        setInstallingServerId(data.id);
        setInstallingAgentId(agentId);
      }
    },
  });

  const reinstallMutation = useMutation({
    mutationFn: async (serverId: string) => {
      const { data, error } = await reinstallMcpServer({
        path: { id: serverId },
        body: {},
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (data?.id) {
        setInstallingServerId(data.id);
      }
    },
  });

  // Poll for installation status
  const statusQuery = useQuery({
    queryKey: ["browser-installation-status", installingServerId],
    queryFn: async () => {
      if (!installingServerId) return null;
      const response = await getMcpServer({
        path: { id: installingServerId },
      });
      return response.data?.localInstallationStatus ?? null;
    },
    refetchInterval: (query) => {
      const status = query.state.data;
      return status === "pending" || status === "discovering-tools"
        ? 2000
        : false;
    },
    enabled: !!installingServerId,
  });

  // When installation completes, invalidate queries and assign tools
  useEffect(() => {
    if (statusQuery.data === "success") {
      const agentId = installingAgentId;
      setInstallingServerId(null);
      setInstallingAgentId(null);
      queryClient.invalidateQueries({ queryKey: ["profile-tools"] });
      queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      toast.success("Browser installed successfully");
      if (agentId) {
        onInstallCompleteRef.current?.(agentId);
      }
    }
    if (statusQuery.data === "error") {
      setInstallingServerId(null);
      setInstallingAgentId(null);
      toast.error("Failed to install browser");
    }
  }, [statusQuery.data, queryClient, installingAgentId]);

  return {
    isInstalling:
      installMutation.isPending ||
      reinstallMutation.isPending ||
      (!!installingServerId &&
        statusQuery.data !== "success" &&
        statusQuery.data !== "error"),
    installBrowser: installMutation.mutateAsync,
    reinstallBrowser: reinstallMutation.mutateAsync,
    installationStatus: statusQuery.data,
  };
}

export function useHasPlaywrightMcpTools(
  agentId: string | undefined,
  conversationId?: string,
) {
  const toolsQuery = useProfileToolsWithIds(agentId);
  const queryClient = useQueryClient();
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // Mutation to assign all Playwright tools to the current agent
  const assignToolsMutation = useMutation({
    mutationFn: async ({
      agentId: targetAgentId,
      conversationId,
    }: {
      agentId: string;
      conversationId?: string;
    }) => {
      const { data: catalogTools } = await getInternalMcpCatalogTools({
        path: { id: PLAYWRIGHT_MCP_CATALOG_ID },
      });
      if (!catalogTools?.length) {
        throw new Error("No Playwright tools found");
      }
      const assignments = catalogTools.map((tool) => ({
        agentId: targetAgentId,
        toolId: tool.id,
        useDynamicTeamCredential: true,
      }));
      const { data } = await bulkAssignTools({ body: { assignments } });
      if (data?.failed?.length) {
        throw new Error(data.failed[0].error);
      }
      // If conversation has custom tool selection, add new tools to enabled list
      if (conversationId) {
        const enabledData = await fetchConversationEnabledTools(conversationId);
        if (enabledData?.hasCustomSelection) {
          const newToolIds = catalogTools.map((t) => t.id);
          const merged = [
            ...new Set([...enabledData.enabledToolIds, ...newToolIds]),
          ];
          await updateConversationEnabledTools({
            path: { id: conversationId },
            body: { toolIds: merged },
          });
        }
      }
    },
    onSuccess: (_data, { agentId: targetAgentId, conversationId }) => {
      invalidateToolAssignmentQueries(queryClient, targetAgentId);
      if (conversationId) {
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId, "enabled-tools"],
        });
      }
      toast.success("Playwright tools assigned to agent");
    },
    onError: (error: Error) => {
      handleApiError({ error });
    },
  });

  // After browser install completes, automatically assign tools to the agent
  const browserInstall = useBrowserInstallation((installedAgentId) => {
    assignToolsMutation.mutate({
      agentId: installedAgentId,
      conversationId: conversationIdRef.current,
    });
  });

  // Fetch user's Playwright server to check reinstallRequired
  const playwrightServersQuery = useMcpServers({
    catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
  });
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  // Find the server owned by the current user (admins see all servers)
  const playwrightServer = playwrightServersQuery.data?.find(
    (s) => s.ownerId === currentUserId,
  );

  // Check if agent has Playwright tools assigned via agent_tools
  const hasPlaywrightMcpTools =
    toolsQuery.data?.some(
      (tool) => tool.catalogId === PLAYWRIGHT_MCP_CATALOG_ID,
    ) ?? false;

  const isPlaywrightInstalledByCurrentUser = !!playwrightServer;

  return {
    hasPlaywrightMcpTools,
    isPlaywrightInstalledByCurrentUser,
    reinstallRequired: playwrightServer?.reinstallRequired ?? false,
    installationFailed: playwrightServer?.localInstallationStatus === "error",
    playwrightServerId: playwrightServer?.id,
    isLoading: toolsQuery.isLoading,
    isInstalling: browserInstall.isInstalling,
    isAssigningTools: assignToolsMutation.isPending,
    installBrowser: browserInstall.installBrowser,
    reinstallBrowser: browserInstall.reinstallBrowser,
    assignToolsToAgent: assignToolsMutation.mutateAsync,
  };
}
