import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

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
} = archestraApiSdk;

// For backward compatibility - returns all agents as an array
export function useAgents(
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

// New paginated hook for the agents page
export function useAgentsPaginated(params?: {
  limit?: number;
  offset?: number;
  sortBy?: "name" | "createdAt" | "toolsCount" | "team";
  sortDirection?: "asc" | "desc";
  name?: string;
}) {
  const { limit, offset, sortBy, sortDirection, name } = params || {};

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
  });
}

export function useDefaultAgent(params?: {
  initialData?: archestraApiTypes.GetDefaultAgentResponses["200"];
}) {
  return useQuery({
    queryKey: ["agents", "default"],
    queryFn: async () => (await getDefaultAgent()).data ?? null,
    initialData: params?.initialData,
  });
}

export function useAgent(id: string | undefined) {
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

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: archestraApiTypes.CreateAgentData["body"]) => {
      const response = await createAgent({ body: data });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

export function useUpdateAgent() {
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

export function useDeleteAgent() {
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
