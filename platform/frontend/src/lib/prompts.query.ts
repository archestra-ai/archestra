import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

const { getPrompts, createPrompt, getPrompt, updatePrompt, deletePrompt } =
  archestraApiSdk;

export function usePrompts(params?: {
  initialData?: archestraApiTypes.GetPromptsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["prompts"],
    queryFn: async () => (await getPrompts()).data ?? [],
    initialData: params?.initialData,
  });
}

export function usePrompt(id: string) {
  return useQuery({
    queryKey: ["prompts", id],
    queryFn: async () => (await getPrompt({ path: { id } })).data ?? null,
    enabled: !!id,
  });
}

export function useCreatePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      agentId: string;
      userPrompt?: string;
      systemPrompt?: string;
    }) => {
      const response = await createPrompt({ body: data });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });
}

export function useUpdatePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: { name?: string; userPrompt?: string; systemPrompt?: string };
    }) => {
      const response = await updatePrompt({ path: { id }, body: data });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
      queryClient.invalidateQueries({ queryKey: ["prompts", variables.id] });
    },
  });
}

export function useDeletePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deletePrompt({ path: { id } });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });
}
