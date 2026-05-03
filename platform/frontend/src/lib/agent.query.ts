import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TABLE_LIMIT,
} from "@/consts";
import { incomingEmailKeys } from "@/lib/chatops/incoming-email.query";
import { handleApiError } from "@/lib/utils";

const {
  createAgent,
  cloneAgent,
  deleteAgent,
  getAgents,
  getAllAgents,
  getDefaultMcpGateway,
  getDefaultLlmProxy,
  getAgent,
  updateAgent,
  getLabelKeys,
  getLabelValues,
  getMemberDefaultAgent,
} = archestraApiSdk;

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
      const response = await getAllAgents({ query: filters });
      return response.data ?? [];
    },
    initialData: params?.initialData,
    enabled: params?.enabled,
  });
}

export function useCloneAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data: responseData, error } = await cloneAgent({
        path: { id },
      });
      if (error) {
        handleApiError(error);
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
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
      },
    ],
    queryFn: async () =>
      (
        await getAgents({
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
          },
        })
      ).data ?? null,
    initialData: useInitialData ? initialData : undefined,
  });
}

export function useDefaultMcpGateway(params?: {
  initialData?: archestraApiTypes.GetDefaultMcpGatewayResponses["200"];
}) {
  return useQuery({
    queryKey: ["mcp-gateways", "default"],
    queryFn: async () => (await getDefaultMcpGateway()).data ?? null,
    initialData: params?.initialData,
  });
}

export function useDefaultLlmProxy(params?: {
  initialData?: archestraApiTypes.GetDefaultLlmProxyResponses["200"];
}) {
  return useQuery({
    queryKey: ["llm-proxy", "default"],
    queryFn: async () => {
      const response = await getDefaultLlmProxy();
      return response.data ?? null;
    },
    initialData: params?.initialData,
  });
}

export function useProfile(id: string | undefined) {
  return useQuery({
    queryKey: ["agents", id],
    queryFn: async () => {
      if (!id) return null;
      const response = await getAgent({ path: { id } });
      return response.data ?? null;
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
        handleApiError(error);
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      // Invalidate profile tokens for the new profile
      if (data?.id) {
        queryClient.invalidateQueries({
          queryKey: ["profileTokens", data.id],
        });
      }
    },
  });
}

export function useUpdateProfile() {
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
        handleApiError(error);
      }
      return responseData;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      // Immediately update the specific agent's cache so navigating to
      // chat (or any other page using useProfile) shows fresh data
      queryClient.setQueryData(["agents", variables.id], data);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
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
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

export function useLabelKeys() {
  return useQuery({
    queryKey: ["agents", "labels", "keys"],
    queryFn: async () => (await getLabelKeys()).data ?? [],
  });
}

export function useLabelValues(params?: { key?: string }) {
  const { key } = params || {};
  return useQuery({
    queryKey: ["agents", "labels", "values", key],
    queryFn: async () =>
      (await getLabelValues({ query: key ? { key } : {} })).data ?? [],
    enabled: key !== undefined,
  });
}

/**
 * Get the current user's default agent ID.
 */
export function useDefaultAgentId() {
  return useQuery({
    queryKey: ["member-default-agent"],
    queryFn: async () => {
      const response = await getMemberDefaultAgent();
      return response.data?.defaultAgentId ?? null;
    },
  });
}

export function useInternalAgents(params?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["agents", "all", { agentType: "agent", excludeBuiltIn: true }],
    queryFn: async () => {
      const response = await getAllAgents({
        query: { agentType: "agent", excludeBuiltIn: true },
      });
      return response.data ?? [];
    },
    enabled: params?.enabled,
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
      const response = await getAllAgents({
        query: { agentType: "agent", excludeBuiltIn: true, scope: "org" },
      });
      return response.data ?? [];
    },
  });
}
