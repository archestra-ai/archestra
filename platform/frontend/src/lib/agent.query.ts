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
  getDefaultAgent,
  updateAgent,
  getLabelKeys,
  getLabelValues,
} = archestraApiSdk;

export function useAgents(params?: {
  initialData?: archestraApiTypes.GetAgentsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["agents"],
    queryFn: async () => (await getAgents()).data ?? null,
    initialData: params?.initialData,
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

export function useLabelValues() {
  return useQuery({
    queryKey: ["agents", "labels", "values"],
    queryFn: async () => (await getLabelValues()).data ?? [],
  });
}
