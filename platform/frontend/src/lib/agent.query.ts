import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  type CreateAgentData,
  createAgent,
  deleteAgent,
  type GetAgentsResponses,
  type GetDefaultAgentResponses,
  getAgents,
  getDefaultAgent,
  type UpdateAgentData,
  updateAgent,
} from "@/lib/clients/api";

export function useAgents(params?: {
  initialData?: GetAgentsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["agents"],
    queryFn: async () => (await getAgents()).data ?? null,
    initialData: params?.initialData,
  });
}

export function useDefaultAgent(params?: {
  initialData?: GetDefaultAgentResponses["200"];
}) {
  return useQuery({
    queryKey: ["agents", "default"],
    queryFn: async () => (await getDefaultAgent()).data ?? null,
    initialData: params?.initialData,
  });
}

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateAgentData["body"]) => {
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
      data: UpdateAgentData["body"];
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
