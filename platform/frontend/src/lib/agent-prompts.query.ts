import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

const { getAgentPrompts, assignAgentPrompts, deleteAgentPrompt } =
  archestraApiSdk;

export function useAgentPrompts(
  agentId: string,
  params?: {
    initialData?: archestraApiTypes.GetAgentPromptsResponses["200"];
  },
) {
  return useSuspenseQuery({
    queryKey: ["agents", agentId, "prompts"],
    queryFn: async () =>
      (await getAgentPrompts({ path: { agentId } })).data ?? [],
    initialData: params?.initialData,
  });
}

export function useAssignAgentPrompts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      data,
    }: {
      agentId: string;
      data: {
        systemPromptId?: string | null;
        regularPromptIds?: string[];
      };
    }) => {
      const response = await assignAgentPrompts({
        path: { agentId },
        body: data,
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["agents", variables.agentId, "prompts"],
      });
    },
  });
}

export function useDeleteAgentPrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      promptId,
    }: {
      agentId: string;
      promptId: string;
    }) => {
      const response = await deleteAgentPrompt({ path: { agentId, promptId } });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["agents", variables.agentId, "prompts"],
      });
    },
  });
}
