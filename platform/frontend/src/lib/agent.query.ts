import {
  archestraApiSdk,
  type archestraApiTypes,
  isSameResourceAccess,
  type ResourceAccessRelation,
} from "@archestra/shared";
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TABLE_LIMIT,
} from "@/consts";
import { toBulkOutcome } from "@/lib/bulk-action";
import { getSavedAgent } from "@/lib/chat/use-chat-preferences";
import { incomingEmailKeys } from "@/lib/chatops/incoming-email.query";
import { useAllMatching } from "@/lib/hooks/use-all-matching";
import { useOrganization } from "@/lib/organization.query";
import {
  BOOTSTRAP_QUERY_RETRY,
  flushPersistedQueryCache,
  PERSISTED_QUERY_META,
  seedOnlyStaleTime,
} from "@/lib/query-persistence";
import { reportApiError, throwOnApiError } from "@/lib/utils/api";

const {
  bulkDeleteAgents,
  createAgent,
  cloneAgent,
  deleteAgent,
  exportAgent,
  getAgentCredentialReadiness,
  getAgentDefaultSuggestedPrompts,
  getAgents,
  getAgentOptions,
  getChatAgentRoster,
  getDefaultMcpGateway,
  getAgent,
  importAgent,
  permanentlyDeleteAgent,
  restoreAgent,
  updateAgent,
  getLabelKeys,
  getLabelValues,
  getMemberDefaultAgent,
  updateMemberDefaultAgent,
  pinAgent,
  unpinAgent,
} = archestraApiSdk;

const chatAgentsQueryKey = [
  "agents",
  "chat-roster",
  "bootstrap",
  "v3",
] as const;

/** Metadata-only internal agents for selectors and runtime labels. */
export async function fetchInternalAgentOptions() {
  const { data, error } = await getAgentOptions({
    query: { agentType: "agent", excludeBuiltIn: true },
  });
  throwOnApiError(error, { toastOnError: false });
  return data ?? [];
}

export function useInternalAgentOptions(params?: { enabled?: boolean }) {
  return useAgentOptions({
    filters: { agentType: "agent", excludeBuiltIn: true },
    enabled: params?.enabled,
  });
}

async function fetchChatAgents() {
  const { data, error } = await getChatAgentRoster({
    query: { bootstrap: true },
  });
  throwOnApiError(error, { toastOnError: false });
  return data ?? [];
}

const delegationTargetAgentsQuery = {
  agentType: "agent",
  excludeBuiltIn: true,
} as const;

export function useDelegationTargetAgents(params?: { enabled?: boolean }) {
  return useAgentOptions({
    filters: delegationTargetAgentsQuery,
    enabled: params?.enabled,
  });
}

/**
 * Agents per request for every roster. The list is paginated on the server, so
 * a roster never loads the whole organization.
 */
export const AGENT_PAGE_SIZE = 100;

/** One page of agents, with the server-side name search applied. */
async function fetchAgentPage(
  query: archestraApiTypes.GetAgentsData["query"],
): Promise<
  Array<
    Omit<
      archestraApiTypes.GetAgentsResponses["200"]["data"][number],
      "pinnedAt"
    >
  >
> {
  const { data, error } = await getAgents({ query });
  throwOnApiError(error, { toastOnError: false });
  return data?.data ?? [];
}

// Returns one page of agents as an array
export function useProfiles(
  params: {
    initialData?: Array<
      Omit<
        archestraApiTypes.GetAgentsResponses["200"]["data"][number],
        "pinnedAt"
      >
    >;
    filters?: archestraApiTypes.GetAgentsData["query"];
    enabled?: boolean;
  } = {},
) {
  const filters = {
    limit: AGENT_PAGE_SIZE,
    ...params?.filters,
  } satisfies archestraApiTypes.GetAgentsData["query"];
  return useQuery({
    queryKey: ["agents", "all", filters],
    queryFn: () => fetchAgentPage(filters),
    initialData: params?.initialData,
    enabled: params?.enabled,
  });
}

/** Names and presentation data only; fetch a resource before editing it. */
export function useAgentOptions(
  params: {
    filters?: archestraApiTypes.GetAgentOptionsData["query"];
    enabled?: boolean;
  } = {},
) {
  const filters = { excludeBuiltIn: true, ...params.filters };
  if (
    filters.agentTypes?.length === 1 &&
    (filters.agentType === undefined ||
      filters.agentType === filters.agentTypes[0])
  ) {
    filters.agentType = filters.agentTypes[0];
    delete filters.agentTypes;
  }
  return useQuery({
    queryKey: ["agents", "options", filters],
    queryFn: async () => {
      if (filters.ids?.length === 0) return [];
      const { data, error } = await getAgentOptions({ query: filters });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: params.enabled,
  });
}

type CloneAgentArgs = {
  id: string;
} & NonNullable<archestraApiTypes.CloneAgentData["body"]>;

export function useCloneAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: CloneAgentArgs) => {
      const { data: responseData, error } = await cloneAgent({
        path: { id },
        body,
      });
      if (error) {
        throw reportApiError(error);
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: memberDefaultAgentQueryKey });
      if (data.id) {
        queryClient.setQueryData(["agents", data.id], data);
      }
    },
  });
}

// Paginated hook for the agents page
export function useProfilesPaginated(
  params?: archestraApiTypes.GetAgentsData["query"] & {
    initialData?: archestraApiTypes.GetAgentsResponses["200"];
    /** Scope of the server seed; never reuse it for a different visibility filter. */
    initialDataExcludeOtherPersonalAgents?: boolean;
    /** Pin slice of the server seed; never reuse it for the other list section. */
    initialDataPinned?: boolean;
    /** `access` filter of the server seed; never reuse it for another selection. */
    initialDataAccess?: ResourceAccessRelation[];
    /** Page size used to produce the server seed. */
    initialDataLimit?: number;
    enabled?: boolean;
  },
) {
  const {
    initialData,
    initialDataExcludeOtherPersonalAgents,
    initialDataPinned,
    initialDataAccess,
    initialDataLimit,
    enabled,
    limit,
    offset,
    sortBy,
    sortDirection,
    name,
    agentTypes,
    scope,
    teamIds,
    authorIds,
    excludeAuthorIds,
    excludeOtherPersonalAgents,
    access,
    sharedWith,
    owner,
    labels,
    status,
    includeActivationSkillsCount,
    providerApiKeyId,
    pinned,
    ids,
    excludeIds,
  } = params || {};

  // Check if we can use initialData (server-side fetched data)
  // Only use it for the first page (offset 0), default sorting, no search filter,
  // no scope filter, AND matching default table page size
  // Note: agentTypes is allowed since the server fetches with the page-specific agentTypes
  const useInitialData =
    offset === 0 &&
    (sortBy === undefined || sortBy === DEFAULT_SORT_BY) &&
    (sortDirection === undefined || sortDirection === DEFAULT_SORT_DIRECTION) &&
    name === undefined &&
    scope === undefined &&
    teamIds === undefined &&
    authorIds === undefined &&
    excludeAuthorIds === undefined &&
    excludeOtherPersonalAgents === initialDataExcludeOtherPersonalAgents &&
    isSameResourceAccess(access, initialDataAccess) &&
    sharedWith === undefined &&
    owner === undefined &&
    pinned === initialDataPinned &&
    labels === undefined &&
    status === undefined &&
    providerApiKeyId === undefined &&
    (limit === undefined ||
      limit === (initialDataLimit ?? DEFAULT_TABLE_LIMIT));

  return useQuery({
    queryKey: [
      "agents",
      {
        limit,
        offset,
        sortBy,
        sortDirection,
        name,
        agentTypes,
        scope,
        teamIds,
        authorIds,
        excludeAuthorIds,
        excludeOtherPersonalAgents,
        access,
        sharedWith,
        owner,
        labels,
        status,
        includeActivationSkillsCount,
        providerApiKeyId,
        pinned,
        ids,
        excludeIds,
      },
    ],
    queryFn: async () => {
      const { data, error } = await getAgents({
        query: {
          limit,
          offset,
          sortBy,
          sortDirection,
          name,
          agentTypes,
          scope,
          teamIds,
          authorIds,
          excludeAuthorIds,
          excludeOtherPersonalAgents,
          access,
          sharedWith,
          owner,
          labels,
          status,
          includeActivationSkillsCount,
          providerApiKeyId,
          pinned,
          ids,
          excludeIds,
        },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    initialData: useInitialData ? initialData : undefined,
    enabled,
    // A reload can restore the snapshot saved just before a pin mutation.
    // Revalidate both sections even while that snapshot is considered fresh.
    refetchOnMount: pinned !== undefined ? "always" : true,
    ...(pinned !== undefined && {
      staleTime: seedOnlyStaleTime(useInitialData ? initialData : undefined),
    }),
    // The list pages restore their last rows on refresh and swap in the fresh
    // page when it lands, so a reload lands on a filled table rather than an
    // empty one. Keyed by the full filter set, so a restored page only ever
    // shows the rows that belong to the filters in the URL.
    meta: PERSISTED_QUERY_META,
  });
}

/** Pin or unpin an agent for the current user. */
export function usePinAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const { error } = pinned
        ? await pinAgent({ path: { id } })
        : await unpinAgent({ path: { id } });
      if (error) {
        reportApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (ok) => {
      if (!ok) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

/**
 * Ids of the agents pinned for the current user, in the Agents page's order:
 * first the ones pinned automatically (their default, their personal chat
 * agent, the organization's default), then the ones they pinned, newest first.
 */
export function usePinnedAgentIds(params?: { enabled?: boolean }) {
  const { data: pinned } = useQuery({
    queryKey: ["agents", "pinned-ids"],
    queryFn: async () => {
      const { data, error } = await getAgents({
        query: { pinned: true, agentTypes: ["agent"], limit: 100, offset: 0 },
      });
      throwOnApiError(error, { toastOnError: false });
      return (data?.data ?? []).map((agent) => agent.id);
    },
    enabled: params?.enabled,
    // A short id list; kept across reloads so pins show without a wait.
    meta: PERSISTED_QUERY_META,
  });
  const { data: personalDefaultAgentId } = useDefaultAgentId();
  const { data: personalChatAgentId } = usePersonalChatAgentId();
  const { data: organization } = useOrganization();
  const organizationDefaultAgentId = organization?.defaultAgentId;
  const data = useMemo(
    () =>
      pinned && [
        ...new Set(
          [
            personalDefaultAgentId,
            personalChatAgentId,
            organizationDefaultAgentId,
            ...pinned,
          ].filter((id): id is string => !!id),
        ),
      ],
    [
      pinned,
      personalDefaultAgentId,
      personalChatAgentId,
      organizationDefaultAgentId,
    ],
  );
  return { data };
}

/**
 * Flip an agent between All and Manual access to tools or subagents. The
 * change saves at once, so the toast offers Undo instead of a Save button.
 * Turning All tools on also turns on progressive tool loading, which is the
 * only surface dynamic access works through (as in the full configuration).
 */
export function useSwitchAgentAccess() {
  const queryClient = useQueryClient();
  const updateProfile = useUpdateProfile();
  const switchAccess = (params: {
    agent: Pick<
      archestraApiTypes.GetAgentResponses["200"],
      "id" | "toolExposureMode"
    >;
    target: "tools" | "subagents";
    all: boolean;
  }) => {
    const { agent, target, all } = params;
    const accessData = (
      on: boolean,
    ): archestraApiTypes.UpdateAgentData["body"] =>
      target === "subagents"
        ? { accessAllSubagents: on }
        : on
          ? { accessAllTools: true, toolExposureMode: "search_and_run_only" }
          : { accessAllTools: false, toolExposureMode: agent.toolExposureMode };
    updateProfile.mutate(
      {
        id: agent.id,
        // Leaving All keeps whatever loading mode it set; Undo restores it.
        data:
          target === "tools" && !all
            ? { accessAllTools: false }
            : accessData(all),
      },
      {
        onSuccess: (saved) => {
          if (!saved) return;
          const what = target === "tools" ? "tool access" : "subagents";
          toast.success(`Switched to ${all ? "All" : "Manual"} ${what}`, {
            action: {
              label: "Undo",
              // Through the client, not the mutation hook: the dialog that
              // owns the hook may have closed by the time Undo is clicked.
              onClick: async () => {
                const { error } = await updateAgent({
                  path: { id: agent.id },
                  body: accessData(!all),
                });
                if (error) {
                  reportApiError(error);
                  return;
                }
                await queryClient.invalidateQueries({ queryKey: ["agents"] });
              },
            },
          });
        },
      },
    );
  };
  return { switchAccess, isPending: updateProfile.isPending };
}

export function useDefaultMcpGateway(params?: {
  initialData?: archestraApiTypes.GetDefaultMcpGatewayResponses["200"];
}) {
  return useQuery({
    queryKey: ["mcp-gateways", "default"],
    queryFn: async () => {
      const { data, error } = await getDefaultMcpGateway();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    initialData: params?.initialData,
  });
}

export function useProfile(
  id: string | undefined,
  params?: { enabled?: boolean },
) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ["agents", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getAgent({ path: { id } });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
    enabled: !!id && (params?.enabled ?? true),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    /**
     * Start from the row the user clicked, when a list already holds it.
     *
     * Opening an agent is a chain, not a single request: `AgentForm` gates
     * roughly ten of its queries on flags derived from the agent itself
     * (`supportsSubagents`, `shouldLoadLlmConfiguration` and
     * `showsModelControl` all read `agentType`), so none of them can start
     * until this one lands. Seeding removes the first link — the form's gates
     * resolve on the first render and the rest fetch immediately, rather than
     * one round trip later.
     *
     * Safe because findCachedAgent excludes compact and tool-free rosters; the
     * remaining list endpoints serialise whole agents with the same
     * `SelectAgentSchema` this route returns. `initialDataUpdatedAt` carries
     * the list's age across, so a stale row still revalidates on its normal
     * schedule instead of being trusted indefinitely.
     */
    initialData: () =>
      id ? findCachedAgent(queryClient, id)?.agent : undefined,
    initialDataUpdatedAt: () =>
      id ? findCachedAgent(queryClient, id)?.updatedAt : undefined,
  });
}

export function useCreateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: archestraApiTypes.CreateAgentData["body"]) => {
      const { data: responseData, error } = await createAgent({ body: data });
      if (error) {
        throw reportApiError(error);
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: memberDefaultAgentQueryKey });
      // Invalidate profile tokens for the new profile
      if (data?.id) {
        queryClient.invalidateQueries({
          queryKey: ["profileTokens", data.id],
        });
      }
    },
  });
}

export function useTransferAgentOwnership() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ownerId }: { id: string; ownerId: string }) => {
      const { data, error } = await archestraApiSdk.transferAgentOwnership({
        path: { id },
        body: { ownerId },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["profileTokens"] });
      queryClient.invalidateQueries({ queryKey: memberDefaultAgentQueryKey });
      toast.success("Ownership transferred");
    },
  });
}

export function useUpdateProfile(options?: { successMessage?: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: archestraApiTypes.UpdateAgentData["body"];
    }) => {
      const { data: responseData, error } = await updateAgent({
        path: { id },
        body: data,
      });
      if (error) {
        throw reportApiError(error);
      }
      return responseData;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.removeQueries({ queryKey: ["agents"], type: "inactive" });
      // Immediately update the specific agent's cache so navigating to
      // chat (or any other page using useProfile) shows fresh data
      queryClient.setQueryData(["agents", variables.id], data);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents", variables.id, "mcp-tools"],
      });
      if (options?.successMessage) {
        toast.success(options.successMessage);
      }
      // Invalidate profile tokens when teams change (tokens are auto-created/deleted)
      queryClient.invalidateQueries({
        queryKey: ["profileTokens", variables.id],
      });
      // Invalidate tokens queries since team changes affect which tokens are visible for a profile
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      queryClient.invalidateQueries({
        queryKey: incomingEmailKeys.promptEmailAddress(variables.id),
      });
      // Invalidate knowledge bases when knowledgeBaseIds change (updates assignedAgents)
      if (variables.data?.knowledgeBaseIds !== undefined) {
        queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      }
      flushPersistedQueryCache(queryClient);
    },
  });
}

export function useDeleteProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteAgent({ path: { id } });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      // Deleting a member's personal default moves it to their next personal
      // agent (or clears it), so the cached value is stale.
      queryClient.invalidateQueries({ queryKey: memberDefaultAgentQueryKey });
    },
  });
}

/**
 * Every profile matching the table's filters, not just the page in view —
 * what backs "select all N agents that match this search query".
 *
 * Shared by the agents, LLM proxy and MCP gateway tables; `agentTypes` is what
 * keeps each one to its own rows.
 */
export function useAllMatchingProfiles(
  params: Omit<
    NonNullable<archestraApiTypes.GetAgentsData["query"]>,
    "limit" | "offset"
  >,
  options?: { enabled?: boolean },
) {
  return useAllMatching({
    queryKey: ["agents", "all-matching", params],
    enabled: options?.enabled,
    fetchPage: async ({ limit, offset }) => {
      const { data, error } = await getAgents({
        query: { ...params, limit, offset },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.data ?? [];
    },
  });
}

export function useBulkDeleteProfiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (profiles: readonly { id: string; name: string }[]) =>
      bulkDeleteAgents({
        body: { ids: profiles.map((profile) => profile.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    // Settled rather than success: a partly applied batch still moved rows, so
    // the list is stale either way.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: memberDefaultAgentQueryKey });
    },
  });
}

export function useRestoreProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await restoreAgent({ path: { id } });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: memberDefaultAgentQueryKey });
      queryClient.setQueryData(["agents", data.id], data);
    },
  });
}

/**
 * Permanently destroy a soft-deleted agent. Irreversible: the row and
 * everything it owns go, while its LLM interaction history survives detached.
 *
 * One endpoint serves every agent type, so callers pass the label their
 * surface uses ("MCP Gateway", "LLM Proxy") to keep the toast in the language
 * of the page the user is on.
 */
export function usePermanentlyDeleteProfile(entityLabel = "Agent") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await permanentlyDeleteAgent({ path: { id } });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (data, id) => {
      if (!data) return;
      toast.success(`${entityLabel} permanently deleted`);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      // The detail query for a now-nonexistent id would 404 on its next fetch.
      queryClient.removeQueries({ queryKey: ["agents", id] });
    },
  });
}

export function useLabelKeys() {
  return useQuery({
    queryKey: ["agents", "labels", "keys"],
    queryFn: async () => {
      const { data, error } = await getLabelKeys();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useLabelValues(params?: { key?: string }) {
  const { key } = params || {};
  return useQuery({
    queryKey: ["agents", "labels", "values", key],
    queryFn: async () => {
      const { data, error } = await getLabelValues({
        query: key ? { key } : {},
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: key !== undefined,
  });
}

export const memberDefaultAgentQueryKey = ["member-default-agent"] as const;

/**
 * The current user's personal default agent id: one of their own personal
 * chat agents, or null when they have none set (the org default applies).
 */
export function useDefaultAgentId() {
  return useQuery({
    ...memberAgentsQuery,
    select: (agents) => agents.defaultAgentId,
  });
}

/**
 * The current user's personal chat agent: the oldest live personal agent they
 * authored (the assistant seeded at their first login, unless deleted). It is
 * reported whether or not it is also their default.
 */
export function usePersonalChatAgentId() {
  return useQuery({
    ...memberAgentsQuery,
    select: (agents) => agents.personalChatAgentId,
  });
}

/**
 * Suggested prompts the platform offers for an agent with none of its own
 * (today: the docs servers' prompts on the caller's personal assistant). The
 * backend decides which apply. They are never stored on the agent.
 */
export function useAgentDefaultSuggestedPrompts(
  agentId: string | null | undefined,
  params: { enabled: boolean },
) {
  return useQuery({
    queryKey: ["agents", agentId, "default-suggested-prompts"],
    queryFn: async () => {
      const { data, error } = await getAgentDefaultSuggestedPrompts({
        path: { id: agentId as string },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: params.enabled && Boolean(agentId),
  });
}

/**
 * Set (an id) or clear (null) the current user's personal default agent.
 */
export function useUpdateDefaultAgentId() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (defaultAgentId: string | null) => {
      const { data, error } = await updateMemberDefaultAgent({
        body: { defaultAgentId },
      });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.setQueryData<MemberAgents>(
        memberDefaultAgentQueryKey,
        (previous) => ({
          personalChatAgentId: previous?.personalChatAgentId ?? null,
          defaultAgentId: data.defaultAgentId,
        }),
      );
    },
  });
}

/**
 * Which agents the current user cannot fully run, and which MCP connections
 * they are missing. Only agents whose author moved them off the default
 * "allow" behavior appear here, so an empty result is the common case.
 */
export function useAgentCredentialReadiness(params: {
  enabled?: boolean;
  ids: string[];
}) {
  return useQuery({
    ...agentCredentialReadinessQuery(params.ids),
    enabled: params.enabled,
  });
}

/** Keep completed readiness batches cached as the picker appends more agents. */
export function useAgentCredentialReadinessPages(params: {
  enabled: boolean;
  batches: string[][];
}) {
  const batches = [
    ...new Map(
      params.batches
        .filter((ids) => ids.length > 0)
        .map((ids) => {
          const query = agentCredentialReadinessQuery(ids);
          return [JSON.stringify(query.queryKey), query] as const;
        }),
    ).values(),
  ];
  const results = useQueries({
    queries: batches.map((query) => ({ ...query, enabled: params.enabled })),
  });
  return { data: results.flatMap((result) => result.data ?? []) };
}

/**
 * Lightweight roster for chat initialization. Large embedded images and
 * editing-only fields stay out of this query; the selected/edited agent is
 * hydrated through useProfile when its full record is needed.
 */
export function useChatAgentPages(params: {
  search?: string;
  enabled: boolean;
}) {
  const query = {
    limit: 20,
    search: params.search || undefined,
    sortBy: "chat" as const,
  };
  return useInfiniteQuery({
    queryKey: ["agents", "chat-roster", "infinite", query],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await archestraApiSdk.getChatAgentRosterPage({
        query: { ...query, cursor: pageParam },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    getNextPageParam: (lastPage) =>
      lastPage?.pagination.hasNext
        ? (lastPage.pagination.nextCursor ?? undefined)
        : undefined,
    enabled: params.enabled,
  });
}

export function useChatAgentReferences(
  ids: (string | null | undefined)[],
  enabled = true,
) {
  const client = useQueryClient();
  const stableIds = [...new Set(ids.filter((id): id is string => !!id))].sort();
  const cachedRows = stableIds.map((id) => findCachedChatAgent(client, id));
  const initialData = cachedRows.every((row) => row !== undefined)
    ? cachedRows
    : undefined;
  return useQuery({
    queryKey: ["agents", "chat-roster", "references", stableIds],
    initialData,
    queryFn: async () => {
      const rows: archestraApiTypes.GetChatAgentRosterResponses["200"] = [];
      for (let offset = 0; offset < stableIds.length; offset += 100) {
        const { data, error } = await getChatAgentRoster({
          query: { ids: stableIds.slice(offset, offset + 100) },
        });
        throwOnApiError(error, { toastOnError: false });
        rows.push(...(data ?? []));
      }
      return rows;
    },
    enabled,
    retry: BOOTSTRAP_QUERY_RETRY,
  });
}

export function useChatAgentBootstrap(enabled = true) {
  return useQuery({
    queryKey: chatAgentsQueryKey,
    queryFn: fetchChatAgents,
    enabled,
    retry: BOOTSTRAP_QUERY_RETRY,
    meta: PERSISTED_QUERY_META,
  });
}

export function useChatAgents(params?: {
  enabled?: boolean;
  ids?: (string | null | undefined)[];
}) {
  const client = useQueryClient();
  const organization = useOrganization();
  const memberDefault = useDefaultAgentId();
  const savedId = getSavedAgent();
  const enabled = params?.enabled ?? true;
  const bootstrap = useChatAgentBootstrap(enabled);
  const references = useChatAgentReferences(
    [
      ...(params?.ids ?? []),
      organization.data?.defaultAgentId,
      memberDefault.data,
      savedId,
    ],
    enabled && !organization.isPending && !memberDefault.isPending,
  );
  const defaultsFailed =
    (organization.isError && !organization.data) ||
    (memberDefault.isError && memberDefault.data === undefined);
  const isPending =
    !defaultsFailed &&
    (bootstrap.isPending ||
      references.isPending ||
      organization.isPending ||
      memberDefault.isPending);
  const data = useMemo(() => {
    if (isPending || defaultsFailed || !references.data || !bootstrap.data)
      return undefined;
    const rows = [...(bootstrap.data ?? []), ...(references.data ?? [])];
    return [...new Map(rows.map((row) => [row.id, row])).values()];
  }, [bootstrap.data, references.data, isPending, defaultsFailed]);
  return {
    ...bootstrap,
    data,
    isPending,
    isLoading: isPending,
    isError:
      bootstrap.isError ||
      references.isError ||
      organization.isError ||
      memberDefault.isError,
    isSuccess: !defaultsFailed && bootstrap.isSuccess && references.isSuccess,
    resolveAgent: (id: string) => findCachedChatAgent(client, id),
    refetch: async () =>
      Promise.all([
        bootstrap.refetch(),
        references.refetch(),
        organization.refetch(),
        memberDefault.refetch(),
      ]),
  };
}

export function useOrgScopedAgents() {
  return useAgentOptions({
    filters: { agentType: "agent", excludeBuiltIn: true, scope: "org" },
  });
}

export function useExportAgent() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await exportAgent({ path: { id } });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success(`Agent "${data.agent.name}" exported successfully`);
    },
  });
}

export function useImportAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: archestraApiTypes.ImportAgentData["body"]) => {
      const { data, error } = await importAgent({ body: payload });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: memberDefaultAgentQueryKey });

      const warningCount = data.warnings.length;
      if (warningCount > 0) {
        toast.warning(
          `Agent "${data.agent.name}" imported with ${warningCount} warning${warningCount !== 1 ? "s" : ""}`,
        );
      } else {
        toast.success(`Agent "${data.agent.name}" imported successfully`);
      }
    },
  });
}

/**
 * Looks for an agent in whatever agent list happens to be cached.
 *
 * Handles both shapes the lists use — a bare array and a paginated
 * `{ data: [...] }` — and skips `["agents", id]` entries, whose data is a
 * single agent rather than a list.
 */
/** Exactly what this route's query function returns, so seeding cannot widen it. */
type CachedAgent = NonNullable<Awaited<ReturnType<typeof getAgent>>["data"]>;

function findCachedAgent(
  queryClient: QueryClient,
  id: string,
): { agent: CachedAgent; updatedAt: number } | undefined {
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: ["agents"] })) {
    // Chat and selector rosters deliberately carry partial Agent data. It is
    // enough to paint and initialize chat, but must never seed an editing form
    // as though it came from the full detail endpoint.
    if (["chat-roster", "options"].includes(String(query.queryKey[1])))
      continue;
    // A list fetched without tools would seed a detail with no tools, which
    // reads as "this agent has none" until the seed goes stale.
    const params = query.queryKey[2] as
      | { includeTools?: boolean; view?: string }
      | undefined;
    if (params?.includeTools === false || params?.view === "chat") continue;
    const cached: unknown = query.state.data;
    const rows = Array.isArray(cached)
      ? cached
      : (cached as { data?: unknown } | null | undefined)?.data;
    if (!Array.isArray(rows)) continue;

    const agent = rows.find(
      (row): row is CachedAgent =>
        typeof row === "object" &&
        row !== null &&
        (row as { id?: unknown }).id === id,
    );
    if (agent) return { agent, updatedAt: query.state.dataUpdatedAt };
  }
  return undefined;
}

type MemberAgents = {
  defaultAgentId: string | null;
  personalChatAgentId: string | null;
};

/** One read for both of the member's agents, shared by the hooks above. */
const memberAgentsQuery = {
  queryKey: memberDefaultAgentQueryKey,
  queryFn: async (): Promise<MemberAgents> => {
    const { data, error } = await getMemberDefaultAgent();
    throwOnApiError(error, { toastOnError: false });
    return {
      defaultAgentId: data?.defaultAgentId ?? null,
      personalChatAgentId: data?.personalChatAgentId ?? null,
    };
  },
};

function findCachedChatAgent(client: QueryClient, id: string) {
  const cached = client.getQueriesData<
    | archestraApiTypes.GetChatAgentRosterResponses["200"]
    | { data: archestraApiTypes.GetChatAgentRosterResponses["200"] }
    | {
        pages: { data: archestraApiTypes.GetChatAgentRosterResponses["200"] }[];
      }
  >({ queryKey: ["agents", "chat-roster"] });
  for (const [, value] of cached) {
    const rows = Array.isArray(value)
      ? value
      : value && "pages" in value
        ? value.pages.flatMap((page) => page.data)
        : value?.data;
    const row = rows?.find((agent) => agent.id === id);
    if (row) return row;
  }
  return undefined;
}

function agentCredentialReadinessQuery(requestedIds: string[]) {
  const ids = [...new Set(requestedIds)].sort();
  return {
    queryKey: ["agents", "credential-readiness", ids],
    queryFn: async () => {
      const rows: archestraApiTypes.GetAgentCredentialReadinessResponses["200"] =
        [];
      for (let offset = 0; offset < ids.length; offset += 200) {
        const { data, error } = await getAgentCredentialReadiness({
          query: { ids: ids.slice(offset, offset + 200) },
        });
        throwOnApiError(error, { toastOnError: false });
        rows.push(...(data ?? []));
      }
      return rows;
    },
  };
}
