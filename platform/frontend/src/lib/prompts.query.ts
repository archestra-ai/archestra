import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

const {
  getPrompts,
  createPrompt,
  getPrompt,
  getPromptVersions,
  updatePrompt,
  deletePrompt,
} = archestraApiSdk;

export function usePrompts(params?: {
  type?: "system" | "regular";
  initialData?: archestraApiTypes.GetPromptsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["prompts", params?.type],
    queryFn: async () =>
      (await getPrompts({ query: { type: params?.type } })).data ?? [],
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

export function usePromptVersions(id: string) {
  return useQuery({
    queryKey: ["prompts", id, "versions"],
    queryFn: async () => (await getPromptVersions({ path: { id } })).data ?? [],
    enabled: !!id,
  });
}

export function useCreatePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      type: "system" | "regular";
      content: string;
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
      data: { name?: string; content?: string };
    }) => {
      const response = await updatePrompt({ path: { id }, body: data });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
      queryClient.invalidateQueries({ queryKey: ["prompts", variables.id] });
      queryClient.invalidateQueries({
        queryKey: ["prompts", variables.id, "versions"],
      });
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
