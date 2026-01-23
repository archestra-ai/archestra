import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  DEFAULT_AGENTS_PAGE_SIZE,
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
} from "./utils";

const {
  createAgent,
  deleteAgent,
  getAgents,
  getAllAgents,
  getDefaultAgent,
  getAgent,
  updateAgent,
  getLabelKeys,
  getLabelValues,
  getAgentVersions,
  rollbackAgent,
} = archestraApiSdk;

// For backward compatibility - returns all agents as an array (suspense version)
export function useProfiles(
  params: {
    initialData?: archestraApiTypes.GetAllAgentsResponses["200"];
    filters?: archestraApiTypes.GetAllAgentsData["query"];
  } = {},
) {
  return useSuspenseQuery({
    queryKey: ["agents", "all", params?.filters],
    queryFn: async () => {
      const response = await getAllAgents({ query: params?.filters });
      return response.data ?? [];
    },
    initialData: params?.initialData,
  });
}

/**
 * Non-suspense version of useProfiles.
 * Use in components that need to show loading states instead of suspense boundaries.
 */
export function useProfilesQuery(
  params: { filters?: archestraApiTypes.GetAllAgentsData["query"] } = {},
) {
  return useQuery({
    queryKey: ["agents", "all", params?.filters],
    queryFn: async () => {
      const response = await getAllAgents({ query: params?.filters });
      return response.data ?? [];
    },
  });
}

// New paginated hook for the agents page
export function useProfilesPaginated(params?: {
  initialData?: archestraApiTypes.GetAgentsResponses["200"];
  limit?: number;
  offset?: number;
  sortBy?: "name" | "createdAt" | "toolsCount" | "team";
  sortDirection?: "asc" | "desc";
  name?: string;
}) {
  const { initialData, limit, offset, sortBy, sortDirection, name } =
    params || {};

  // Check if we can use initialData (server-side fetched data)
  // Only use it for the first page (offset 0), default sorting, no search filter,
  // AND matching default page size (20)
  const useInitialData =
    offset === 0 &&
    (sortBy === undefined || sortBy === DEFAULT_SORT_BY) &&
    (sortDirection === undefined || sortDirection === DEFAULT_SORT_DIRECTION) &&
    name === undefined &&
    (limit === undefined || limit === DEFAULT_AGENTS_PAGE_SIZE);

  return useSuspenseQuery({
    queryKey: ["agents", { limit, offset, sortBy, sortDirection, name }],
    queryFn: async () =>
      (
        await getAgents({
          query: {
            limit,
            offset,
            sortBy,
            sortDirection,
            name,
          },
        })
      ).data ?? null,
    initialData: useInitialData ? initialData : undefined,
  });
}

export function useDefaultProfile(params?: {
  initialData?: archestraApiTypes.GetDefaultAgentResponses["200"];
}) {
  return useQuery({
    queryKey: ["agents", "default"],
    queryFn: async () => (await getDefaultAgent()).data ?? null,
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
      const response = await createAgent({ body: data });
      return response.data;
    },
    onSuccess: (data) => {
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
      const response = await updateAgent({ path: { id }, body: data });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      // Invalidate profile tokens when teams change (tokens are auto-created/deleted)
      queryClient.invalidateQueries({
        queryKey: ["profileTokens", variables.id],
      });
      // Invalidate tokens queries since team changes affect which tokens are visible for a profile
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
}

export function useDeleteProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deleteAgent({ path: { id } });
      return response.data;
    },
    onSuccess: () => {
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

// ============================================================================
// Internal Agents (Prompt-based agents) - Version History & Rollback
// ============================================================================

/**
 * Get internal agents only (agents with prompts).
 * Non-suspense version for components that need loading states.
 */
export function useInternalAgents() {
  return useQuery({
    queryKey: ["agents", "all", { agentType: "agent" }],
    queryFn: async () => {
      const response = await getAllAgents({ query: { agentType: "agent" } });
      return response.data ?? [];
    },
  });
}

/**
 * Get version history for an internal agent.
 * Only applicable to internal agents (agents with prompts).
 */
export function useAgentVersions(id: string | undefined) {
  return useQuery({
    queryKey: ["agents", id, "versions"],
    queryFn: async () => {
      if (!id) return null;
      const response = await getAgentVersions({ path: { id } });
      return response.data ?? null;
    },
    enabled: !!id,
  });
}

/**
 * Rollback an internal agent to a previous version.
 * Only applicable to internal agents (agents with prompts).
 */
export function useRollbackAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, version }: { id: string; version: number }) => {
      const response = await rollbackAgent({
        path: { id },
        body: { version },
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agents", variables.id] });
      queryClient.invalidateQueries({
        queryKey: ["agents", variables.id, "versions"],
      });
    },
  });
}
