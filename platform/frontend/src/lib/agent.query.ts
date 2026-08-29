import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TABLE_LIMIT,
} from "@/consts";
import { toBulkOutcome } from "@/lib/bulk-action";
import { incomingEmailKeys } from "@/lib/chatops/incoming-email.query";
import { useAllMatching } from "@/lib/hooks/use-all-matching";
import { PERSISTED_QUERY_META } from "@/lib/query-persistence";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  bulkDeleteAgents,
  bulkUpdateAgents,
  createAgent,
  cloneAgent,
  convertAgentToSkill,
  suggestSkillDescription,
  deleteAgent,
  exportAgent,
  getAgentCredentialReadiness,
  getAgents,
  getAllAgents,
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
} = archestraApiSdk;

/**
 * The roster, without each agent's tools. No consumer of this list reads them
 * — the pickers that show tools fetch them per agent — while the refs carry
 * every tool's name and description, which on an organization of any size is
 * the great majority of the response. Dropping them is what lets the new-chat
 * screen, whose first paint is gated on this list, stop waiting on megabytes
 * it does not draw.
 */
const internalAgentsQuery = {
  agentType: "agent",
  excludeBuiltIn: true,
  includeTools: false,
} as const;

export const internalAgentsQueryKey = [
  "agents",
  "all",
  internalAgentsQuery,
] as const;

export async function fetchInternalAgents() {
  const { data, error } = await getAllAgents({ query: internalAgentsQuery });
  throwOnApiError(error, { toastOnError: false });
  return data ?? [];
}

const delegationTargetAgentsQuery = {
  agentType: "agent",
  excludeBuiltIn: true,
  includeAdvisor: true,
} as const;

/**
 * Agents that can be picked as a subagent. Separate from
 * {@link useInternalAgents} because the advisor belongs here and nowhere else:
 * it is a target to delegate to, not an agent to start a conversation with.
 */
export function useDelegationTargetAgents(params?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["agents", "all", delegationTargetAgentsQuery],
    queryFn: async () => {
      const { data, error } = await getAllAgents({
        query: delegationTargetAgentsQuery,
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: params?.enabled,
    // No staleTime override: inherit the client default so several components
    // mounting this hook during one page load share a single fetch instead of
    // each observer refetching the whole roster. Agent mutations invalidate
    // ["agents"] queries, so edits still show up immediately.
  });
}

// Returns all agents as an array
export function useProfiles(
  params: {
    initialData?: archestraApiTypes.GetAllAgentsResponses["200"];
    filters?: archestraApiTypes.GetAllAgentsData["query"];
    enabled?: boolean;
  } = {},
) {
  const filters = {
    excludeBuiltIn: true,
    ...params?.filters,
  } satisfies archestraApiTypes.GetAllAgentsData["query"];
  return useQuery({
    queryKey: ["agents", "all", filters],
    queryFn: async () => {
      const { data, error } = await getAllAgents({ query: filters });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    initialData: params?.initialData,
    enabled: params?.enabled,
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

type ConvertAgentToSkillArgs = {
  id: string;
} & archestraApiTypes.ConvertAgentToSkillData["body"];

export function useConvertAgentToSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: ConvertAgentToSkillArgs) => {
      const { data, error } = await convertAgentToSkill({
        path: { id },
        body,
      });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      // the source agent may have been deleted, so refresh the agents list too.
      if (data.deletedAgent) {
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      }
      toast.success(
        data.deletedAgent
          ? `Created skill "${data.skill.name}" and removed the agent`
          : `Created skill "${data.skill.name}" from agent`,
      );
    },
  });
}

/**
 * Suggests a skill description for an agent (LLM-generated) for the
 * convert-to-skill dialog. Read-only: it neither creates a skill nor mutates
 * the agent, so it invalidates nothing — the caller fills the form field.
 */
export function useSuggestSkillDescription() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await suggestSkillDescription({ path: { id } });
      if (error) {
        throw reportApiError(error);
      }
      return data?.description ?? null;
    },
  });
}

// Paginated hook for the agents page
export function useProfilesPaginated(
  params?: archestraApiTypes.GetAgentsData["query"] & {
    initialData?: archestraApiTypes.GetAgentsResponses["200"];
  },
) {
  const {
    initialData,
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
    labels,
    status,
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
    excludeOtherPersonalAgents === undefined &&
    labels === undefined &&
    status === undefined &&
    (limit === undefined || limit === DEFAULT_TABLE_LIMIT);

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
        labels,
        status,
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
          labels,
          status,
        },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    initialData: useInitialData ? initialData : undefined,
    // The list pages restore their last rows on refresh and swap in the fresh
    // page when it lands, so a reload lands on a filled table rather than an
    // empty one. Keyed by the full filter set, so a restored page only ever
    // shows the rows that belong to the filters in the URL.
    meta: PERSISTED_QUERY_META,
  });
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

export function useProfile(id: string | undefined) {
  return useQuery({
    queryKey: ["agents", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getAgent({ path: { id } });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
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
      // Immediately update the specific agent's cache so navigating to
      // chat (or any other page using useProfile) shows fresh data
      queryClient.setQueryData(["agents", variables.id], data);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
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
 * Deletes a selection of profiles — agents and MCP gateways are both
 * profiles, so their tables share this.
 *
 * There is no bulk delete route, so this fans out over the single-item one.
 * It deliberately does NOT go through `useDeleteProfile`: that reports each
 * failure with its own toast, which for a selection means one toast per row.
 * The caller reports the batch once instead, via `reportBulkOutcome`.
 */
/**
 * Every profile matching the table's filters, not just the page in view —
 * what backs "select all N agents that match this search query".
 *
 * Shared by the agents, LLM proxy and MCP gateway tables; `agentTypes` is what
 * keeps each one to its own rows.
 */
/**
 * Sets one visibility across a selection of profiles.
 *
 * One request to the agents bulk route, which reports per-agent outcomes. The
 * wire names differ from skills — `teams`/`users` rather than
 * `teamIds`/`userIds` — which is why the shared dialog hands over a neutral
 * shape and each resource maps it.
 */
export function useBulkUpdateProfileVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      profiles,
      scope,
      teamIds,
      userIds,
    }: {
      profiles: readonly { id: string; name: string }[];
      scope: "personal" | "team" | "org";
      teamIds: string[];
      userIds: string[];
    }) =>
      bulkUpdateAgents({
        body: {
          ids: profiles.map((profile) => profile.id),
          scope,
          teams: teamIds,
          users: userIds,
        },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

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
    queryKey: memberDefaultAgentQueryKey,
    queryFn: async () => {
      const { data, error } = await getMemberDefaultAgent();
      throwOnApiError(error, { toastOnError: false });
      return data?.defaultAgentId ?? null;
    },
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
      queryClient.setQueryData(memberDefaultAgentQueryKey, data.defaultAgentId);
    },
  });
}

/**
 * Which agents the current user cannot fully run, and which MCP connections
 * they are missing. Only agents whose author moved them off the default
 * "allow" behavior appear here, so an empty result is the common case.
 */
export function useAgentCredentialReadiness(params?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["agents", "credential-readiness"],
    queryFn: async () => {
      const { data, error } = await getAgentCredentialReadiness();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: params?.enabled,
  });
}

export function useInternalAgents(params?: { enabled?: boolean }) {
  return useQuery({
    queryKey: internalAgentsQueryKey,
    queryFn: fetchInternalAgents,
    enabled: params?.enabled,
    // No staleTime override: inherit the client default so several components
    // mounting this hook during one page load share a single fetch instead of
    // each observer refetching the whole roster. Agent mutations invalidate
    // ["agents"] queries, so edits still show up immediately.
    //
    // Restored on refresh because the new-chat screen cannot draw without it:
    // which agent a new chat starts on is resolved from this roster, so an
    // unrestored copy is a full-area spinner rather than a stale name. It is
    // names and labels the picker already shows, and carries no credential (an
    // agent references its key by id).
    meta: PERSISTED_QUERY_META,
  });
}

export function useOrgScopedAgents() {
  return useQuery({
    queryKey: [
      "agents",
      "all",
      { agentType: "agent", excludeBuiltIn: true, scope: "org" as const },
    ],
    queryFn: async () => {
      const { data, error } = await getAllAgents({
        query: { agentType: "agent", excludeBuiltIn: true, scope: "org" },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
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
