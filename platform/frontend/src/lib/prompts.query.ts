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
  initialData?: archestraApiTypes.GetPromptsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["prompts"],
    queryFn: async () => (await getPrompts()).data ?? [],
    initialData: params?.initialData,
  });
}

/**
 * Non-suspense version of usePrompts.
 * Use in components that need to show loading states instead of suspense boundaries.
 */
export function usePromptsQuery() {
  return useQuery({
    queryKey: ["prompts"],
    queryFn: async () => (await getPrompts()).data ?? [],
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
    queryFn: async () =>
      (await getPromptVersions({ path: { id } })).data ?? null,
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
      allowedChatops?: string[];
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
      data: {
        name?: string;
        agentId?: string;
        userPrompt?: string;
        systemPrompt?: string;
        allowedChatops?: string[];
      };
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

export function useRollbackPrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, version }: { id: string; version: number }) => {
      const response = await fetch(`/api/prompts/${id}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!response.ok) throw new Error("Rollback failed");
      return response.json();
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
