import {
  archestraApiSdk,
  type archestraApiTypes,
  PLAYWRIGHT_MCP_CATALOG_ID,
  PLAYWRIGHT_MCP_SERVER_NAME,
} from "@archestra/shared";
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { invalidateToolAssignmentQueries } from "@/lib/agent-tools.hook";
import { useSession } from "@/lib/auth/auth.query";
import { callApi } from "@/lib/chat/api-call";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import {
  type ConversationFileItem,
  deleteTargetFor,
} from "@/lib/chat/conversation-files";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { handleApiError } from "@/lib/utils";
import websocketService from "@/lib/websocket/websocket";

const {
  getChatConversations,
  getChatConversation,
  getChatConversationFiles,
  getChatAgentMcpTools,
  createChatConversation,
  updateChatConversation,
  setConversationHooksDebug,
  markChatConversationRead,
  clearChatConversationErrors,
  compactChatConversation,
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
  getMemberDefaultModel,
  resolveChatMcpElicitation,
  updateMemberDefaultModel,
  deleteChatAttachment,
  deleteSkillSandboxArtifact,
} = archestraApiSdk;

/**
 * Invalidate every cache entry that should refresh when a chat turn produces or
 * rewrites files. Always refreshes the chat's own Files panel
 * (`["conversation-files", id]`) and the conversation (for a rewritten
 * artifact); when the chat belongs to a project, also refreshes that project's
 * Files panel (`["projects", projectId, "files"]`).
 *
 * The project cross-invalidation is the symmetric counterpart to the
 * project-side mutations that invalidate `["conversation-files"]`. Without it, a
 * file created inside a project chat stays invisible in the project's Files
 * panel until a hard reload — navigating there via the breadcrumb keeps the
 * cached (stale) list because the query was never marked stale.
 */
export function invalidateConversationFileQueries(
  queryClient: QueryClient,
  {
    conversationId,
    projectId,
  }: { conversationId: string; projectId?: string | null },
) {
  queryClient.invalidateQueries({
    queryKey: ["conversation-files", conversationId],
  });
  queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
  if (projectId) {
    queryClient.invalidateQueries({
      queryKey: ["projects", projectId, "files"],
    });
  }
}

export function mergeUpdatedConversationIntoCache(
  oldConversation:
    | archestraApiTypes.GetChatConversationResponses["200"]
    | undefined,
  updatedConversation: archestraApiTypes.UpdateChatConversationResponses["200"],
  variables: { id: string } & NonNullable<
    archestraApiTypes.UpdateChatConversationData["body"]
  >,
) {
  if (!oldConversation) {
    return updatedConversation;
  }

  const merged = { ...oldConversation };

  if (variables.title !== undefined) {
    merged.title = updatedConversation.title;
  }
  if (variables.modelId !== undefined || variables.agentId !== undefined) {
    merged.modelId = updatedConversation.modelId;
  }
  if (variables.chatApiKeyId !== undefined || variables.agentId !== undefined) {
    merged.chatApiKeyId = updatedConversation.chatApiKeyId;
  }
  if (variables.agentId !== undefined) {
    merged.agentId = updatedConversation.agentId;
    merged.agent = updatedConversation.agent;
  }
  if (variables.pinnedAt !== undefined) {
    merged.pinnedAt = updatedConversation.pinnedAt;
  }

  return merged;
}

export function useConversation(conversationId?: string) {
  return useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => {
      if (!conversationId) return null;
      // 400/404 are handled gracefully by the UI, so suppress their toast.
      return callApi(
        () => getChatConversation({ path: { id: conversationId } }),
        null,
        {
          silentStatuses: [400, 404],
        },
      );
    },
    enabled: !!conversationId,
    staleTime: 0, // Always refetch to ensure we have the latest messages
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't refetch when window gains focus
    retry: false, // Don't retry on error to avoid multiple 404s
  });
}

export function useConversationFiles(conversationId?: string) {
  return useQuery({
    queryKey: ["conversation-files", conversationId],
    queryFn: () => {
      if (!conversationId) return null;
      return callApi(
        () => getChatConversationFiles({ path: { id: conversationId } }),
        null,
        { silent: true },
      );
    },
    enabled: !!conversationId,
    staleTime: 0,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/** Route a single file to its delete endpoint by source. */
async function deleteConversationFileItem(item: ConversationFileItem) {
  return deleteTargetFor(item).kind === "attachment"
    ? deleteChatAttachment({ path: { id: item.id } })
    : deleteSkillSandboxArtifact({ path: { artifactId: item.id } });
}

/** Delete one file from the chat Files panel (attachment or artifact). */
export function useDeleteConversationFile(conversationId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (item: ConversationFileItem) => {
      const { error } = await deleteConversationFileItem(item);
      if (error) {
        handleApiError(error);
        throw error;
      }
    },
    onSuccess: () => {
      toast.success("File deleted");
    },
    onSettled: () => {
      if (conversationId) {
        queryClient.invalidateQueries({
          queryKey: ["conversation-files", conversationId],
        });
      }
    },
  });
}

/**
 * Delete several files at once. Runs the per-file deletes concurrently and
 * reports a single summary toast and a single cache invalidation, instead of
 * one of each per file.
 */
export function useBulkDeleteConversationFiles(conversationId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (items: ConversationFileItem[]) => {
      const results = await Promise.allSettled(
        items.map((item) => deleteConversationFileItem(item)),
      );
      // hey-api resolves with `{ error }` rather than throwing, so a failure is
      // either a rejected promise or a present error payload. Report the ids
      // that failed so the caller can keep them selected / still open.
      const failedIds = items
        .filter((_, i) => {
          const r = results[i];
          return r.status === "rejected" || r.value.error != null;
        })
        .map((item) => item.id);
      return { total: items.length, failedIds };
    },
    onSuccess: ({ total, failedIds }) => {
      const deleted = total - failedIds.length;
      if (failedIds.length === 0) {
        toast.success(`Deleted ${total} ${total === 1 ? "file" : "files"}`);
      } else {
        toast.error(
          `Deleted ${deleted} of ${total}; ${failedIds.length} failed`,
        );
      }
    },
    onSettled: () => {
      if (conversationId) {
        queryClient.invalidateQueries({
          queryKey: ["conversation-files", conversationId],
        });
      }
    },
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
    queryFn: () => {
      const trimmedSearch = search?.trim();
      return callApi(
        () =>
          getChatConversations({
            query: trimmedSearch ? { search: trimmedSearch } : undefined,
          }),
        [],
      );
    },
    enabled,
    staleTime: search ? 0 : 2_000, // No stale time for searches, 2 seconds otherwise
    gcTime: 10 * 60 * 1000,
    // Backstop for the conversation_updated websocket push (see
    // useConversationUpdatedCacheSync): if the socket was down when a message
    // landed, refocusing or reconnecting still refreshes the unread indicators.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Mark a conversation read (owner-only on the server), clearing its sidebar
 * new-messages dot. Optimistically flips `unread` to false across cached
 * conversation lists so the dot disappears the instant the chat is opened; the
 * optimistic write also stops {@link useKeepViewedConversationRead} from
 * re-firing while the request is in flight.
 */
export function useMarkConversationRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      callApi(() => markChatConversationRead({ path: { id } }), null),
    onMutate: ({ id }) => {
      queryClient.setQueriesData<
        archestraApiTypes.GetChatConversationsResponses["200"]
      >({ queryKey: ["conversations"] }, (old) =>
        old
          ? old.map((c) =>
              c.id === id && c.unread ? { ...c, unread: false } : c,
            )
          : old,
      );
    },
  });
}

/**
 * Keep the conversation shown in the URL marked read: whenever it appears
 * unread in the list cache — on open, or when the conversation_updated push
 * refreshes the list while you're viewing it — POST a read. Keyed on the live
 * pathname, not page-held state, so a freshly-created chat whose id lags the
 * URL never clears a chat you have already navigated away from.
 */
export function useKeepViewedConversationRead() {
  const pathname = usePathname();
  const { mutate: markRead } = useMarkConversationRead();
  const { data: conversations } = useConversations({});

  const viewedConversationId = pathname.startsWith("/chat/")
    ? (pathname.split("/").at(-1) ?? undefined)
    : undefined;
  const isViewedUnread = viewedConversationId
    ? !!conversations?.find((c) => c.id === viewedConversationId)?.unread
    : false;

  useEffect(() => {
    if (viewedConversationId && isViewedUnread) {
      markRead({ id: viewedConversationId });
    }
  }, [viewedConversationId, isViewedUnread, markRead]);
}

/**
 * Refresh the sidebar's unread indicators when the server pushes a
 * conversation_updated message (a turn finished in one of the owner's chats).
 * This is what surfaces the dot on a backgrounded chat whose stream completion
 * the client never witnessed. Mount once, app-wide.
 */
export function useConversationUpdatedCacheSync(enabled = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    websocketService.connect();
    return websocketService.subscribe("conversation_updated", () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    });
  }, [enabled, queryClient]);
}

export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      modelId,
      chatApiKeyId,
      title,
      projectId,
    }: NonNullable<archestraApiTypes.CreateChatConversationData["body"]>) =>
      callApi(
        () =>
          createChatConversation({
            body: {
              agentId,
              modelId,
              chatApiKeyId: chatApiKeyId ?? undefined,
              title,
              projectId: projectId ?? undefined,
            },
          }),
        null,
      ),
    onSuccess: (newConversation) => {
      if (!newConversation) return;
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // Immediately populate the individual conversation cache to avoid loading state
      queryClient.setQueryData(
        ["conversation", newConversation.id],
        newConversation,
      );
    },
  });
}

export function useUpdateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      title,
      modelId,
      chatApiKeyId,
      agentId,
      pinnedAt,
    }: { id: string } & NonNullable<
      archestraApiTypes.UpdateChatConversationData["body"]
    >) =>
      callApi(
        () =>
          updateChatConversation({
            path: { id },
            body: { title, modelId, chatApiKeyId, agentId, pinnedAt },
          }),
        null,
      ),
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.setQueryData(
        ["conversation", variables.id],
        (old: typeof data | undefined) =>
          mergeUpdatedConversationIntoCache(old, data, variables),
      );

      // Update title in cache
      if (variables.title !== undefined) {
        queryClient.setQueriesData<
          archestraApiTypes.GetChatConversationsResponses["200"]
        >({ queryKey: ["conversations"] }, (old) =>
          old?.map((c) =>
            c.id === variables.id ? { ...c, title: data.title } : c,
          ),
        );
      }
      // Only invalidate the conversations list for sidebar-relevant changes
      // (pin status, agent). Model/key updates don't affect the sidebar
      // and unnecessary invalidation causes cascading re-renders.
      if (variables.pinnedAt !== undefined || variables.agentId) {
        queryClient.invalidateQueries({ queryKey: ["conversations"] });
      }
      if (variables.agentId) {
        // Agent changed — invalidate tools-related queries
        queryClient.invalidateQueries({
          queryKey: ["conversation", variables.id, "enabled-tools"],
        });
      }
    },
  });
}

/**
 * The current user's default (model, key) pair — the "member" level of the
 * model-resolution chain. Used to preselect the model when opening a new chat.
 */
export function useMemberDefaultModel() {
  return useQuery({
    queryKey: ["member-default-model"],
    queryFn: () =>
      callApi(() => getMemberDefaultModel(), {
        modelId: null,
        chatApiKeyId: null,
      }),
  });
}

/**
 * Persist the current user's default (model, key) pair. Fired whenever the
 * user changes the model in chat so the next new chat reuses their choice
 * (the "member" level of the model-resolution chain).
 */
export function useUpdateMemberDefaultModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: {
      modelId: string | null;
      chatApiKeyId: string | null;
    }) => callApi(() => updateMemberDefaultModel({ body }), null),
    onSuccess: (data) => {
      if (data) {
        queryClient.setQueryData(["member-default-model"], data);
      }
    },
  });
}

export function usePinConversation() {
  const updateMutation = useUpdateConversation();

  return useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const pinnedAt = pinned ? new Date().toISOString() : null;
      return updateMutation.mutateAsync({ id, pinnedAt });
    },
  });
}

export function useCompactConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      callApi(() => compactChatConversation({ path: { id } }), null),
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.setQueryData(
        ["conversation", variables.id],
        data.conversation,
      );
      queryClient.invalidateQueries({
        queryKey: ["conversation", variables.id],
      });
    },
  });
}

/**
 * Clear a conversation's recorded chat errors. Used by the scheduled-run
 * "Try again" affordance: after wiping the error rows we invalidate the
 * conversation so the inline error card disappears before the prompt is resent.
 */
export function useClearChatErrors() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      callApi(() => clearChatConversationErrors({ path: { id } }), null),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", variables.id],
      });
    },
  });
}

/**
 * Toggle per-conversation hook debug mode (admin only). Invalidating the
 * conversation query re-runs the server read gate, and the chat page folds the
 * refetched messages into the live chat state (mergePersistedMessageMetadata),
 * so hook debug chips appear (enabled) or disappear (disabled) in place.
 */
export function useToggleHooksDebug() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      callApi(
        () => setConversationHooksDebug({ path: { id }, body: { enabled } }),
        null,
      ),
    onSuccess: (data, variables) => {
      if (!data) return;
      toast.success(
        data.hooksDebugEnabled
          ? "Hook debug mode enabled"
          : "Hook debug mode disabled",
      );
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
      if (error) {
        handleApiError(error);
        // Throw to trigger onError rollback for optimistic cache removal
        throw error;
      }
      return data;
    },
    onMutate: async (deletedId) => {
      // Cancel in-flight refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ["conversations"] });

      // Snapshot all conversation list caches (one per search query) for rollback
      const previousQueries = queryClient.getQueriesData<
        archestraApiTypes.GetChatConversationsResponses["200"]
      >({
        queryKey: ["conversations"],
      });

      // Optimistically remove the conversation from every cached list
      queryClient.setQueriesData<
        archestraApiTypes.GetChatConversationsResponses["200"]
      >({ queryKey: ["conversations"] }, (old) =>
        old ? old.filter((c) => c.id !== deletedId) : old,
      );

      return { previousQueries };
    },
    onError: (_error, _deletedId, context) => {
      // Roll back optimistic removal on failure
      if (context?.previousQueries) {
        for (const [queryKey, data] of context.previousQueries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSuccess: (_data, deletedId) => {
      queryClient.removeQueries({ queryKey: ["conversation", deletedId] });

      // Clean up localStorage keys associated with this conversation
      if (typeof window !== "undefined") {
        const keys = conversationStorageKeys(deletedId);
        localStorage.removeItem(keys.rightPanelOpen);
        localStorage.removeItem(keys.rightPanelTab);
        localStorage.removeItem(keys.draft);
      }

      toast.success("Conversation deleted");
    },
    onSettled: () => {
      // Always refetch to ensure server state is in sync
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useStopChatStream() {
  return useMutation({
    mutationFn: (conversationId: string) =>
      callApi(() => stopChatStream({ path: { id: conversationId } }), null),
  });
}

export function useResolveChatMcpElicitation() {
  type ResolveChatMcpElicitationBody = NonNullable<
    archestraApiTypes.ResolveChatMcpElicitationData["body"]
  >;

  return useMutation({
    mutationFn: async ({
      id,
      conversationId,
      action,
      content,
    }: {
      id: string;
      conversationId: string;
      action: ResolveChatMcpElicitationBody["action"];
      content?: ResolveChatMcpElicitationBody["content"];
    }) =>
      callApi(
        () =>
          resolveChatMcpElicitation({
            path: { id },
            body: { conversationId, action, content },
          }),
        null,
      ),
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
    }) =>
      callApi(
        () =>
          generateChatConversationTitle({ path: { id }, body: { regenerate } }),
        null,
      ),
    onSuccess: (data, variables) => {
      if (!data) {
        return;
      }

      queryClient.setQueryData(
        ["conversation", variables.id],
        (old: archestraApiTypes.GetChatConversationResponses["200"] | null) =>
          old ? { ...old, title: data.title } : old,
      );
      queryClient.setQueriesData<
        archestraApiTypes.GetChatConversationsResponses["200"]
      >({ queryKey: ["conversations"] }, (old) =>
        old?.map((c) =>
          c.id === variables.id ? { ...c, title: data.title } : c,
        ),
      );
    },
  });
}

export function useChatProfileMcpTools(agentId: string | undefined) {
  return useQuery({
    queryKey: ["chat", "agents", agentId, "mcp-tools"],
    queryFn: () => {
      if (!agentId) return [];
      return callApi(() => getChatAgentMcpTools({ path: { agentId } }), []);
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
  const response = await getConversationEnabledTools({
    path: { id: conversationId },
  });
  if (response.error) {
    return {
      data: null,
      status: response.response.status,
    };
  }

  return {
    data: response.data,
    status: response.response.status,
  };
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
      const result = await fetchConversationEnabledTools(conversationId);
      if (!result.data) {
        if (result.status !== 404) {
          handleApiError({
            error: new Error("Failed to fetch enabled tools"),
          });
        }
        return null;
      }
      return result.data;
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
    }) =>
      callApi(
        () =>
          updateConversationEnabledTools({
            path: { id: conversationId },
            body: { toolIds },
          }),
        null,
      ),
    onSuccess: (data, variables) => {
      if (!data) return;
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
    mutationFn: (conversationId: string) =>
      callApi(
        () => deleteConversationEnabledTools({ path: { id: conversationId } }),
        null,
      ),
    onSuccess: (data, conversationId) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId, "enabled-tools"],
      });
    },
  });
}

/**
 * Fetch MCP tools for an agent (raw function for use with useQueries).
 */
export async function fetchAgentMcpTools(agentId: string | undefined) {
  if (!agentId) return [];
  return callApi(() => getAgentTools({ path: { agentId } }), []);
}

/**
 * Get profile tools with IDs (for the manage tools dialog)
 * Returns full tool objects including IDs needed for enabled tools junction table
 */
export function useProfileToolsWithIds(agentId: string | undefined) {
  return useQuery({
    queryKey: ["agents", agentId, "tools", "mcp-only"],
    queryFn: () => fetchAgentMcpTools(agentId),
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
    placeholderData: keepPreviousData,
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
      const data = await callApi(
        () => getAgentTools({ path: { agentId } }),
        [],
      );
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
    mutationFn: (agentId: string) =>
      callApi(
        () =>
          installMcpServer({
            body: {
              name: PLAYWRIGHT_MCP_SERVER_NAME,
              catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
              agentIds: [agentId],
            },
          }),
        null,
      ),
    onSuccess: (data, agentId) => {
      if (data?.id) {
        setInstallingServerId(data.id);
        setInstallingAgentId(agentId);
      }
    },
  });

  const reinstallMutation = useMutation({
    mutationFn: (serverId: string) =>
      callApi(
        () => reinstallMcpServer({ path: { id: serverId }, body: {} }),
        null,
      ),
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
  options?: { autoAssignAfterInstall?: boolean },
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
        resolveAtCallTime: true,
      }));
      const { data } = await bulkAssignTools({ body: { assignments } });
      if (data?.failed?.length) {
        throw new Error(data.failed[0].error);
      }
      // If conversation has custom tool selection, add new tools to enabled list
      if (conversationId) {
        const enabledData = await fetchConversationEnabledTools(conversationId);
        if (enabledData?.data?.hasCustomSelection) {
          const newToolIds = catalogTools.map((t) => t.id);
          const merged = [
            ...new Set([...enabledData.data.enabledToolIds, ...newToolIds]),
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
    },
    onError: (error: Error) => {
      handleApiError({ error });
    },
  });

  // After browser install completes, automatically assign tools to the agent
  // (unless autoAssignAfterInstall is explicitly set to false)
  const browserInstall = useBrowserInstallation((installedAgentId) => {
    if (options?.autoAssignAfterInstall !== false) {
      assignToolsMutation.mutate({
        agentId: installedAgentId,
        conversationId: conversationIdRef.current,
      });
    }
  });

  // Fetch user's Playwright server to check reinstallRequired
  const playwrightServersQuery = useMcpServers({
    catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
  });
  const { data: session } = useSession();
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
