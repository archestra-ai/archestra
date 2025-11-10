import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

const { getDefaultDualLlmConfig, updateDualLlmConfig } = archestraApiSdk;

export function useDualLlmConfig(params?: {
  initialData?: archestraApiTypes.GetDefaultDualLlmConfigResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["dual-llm-config", "default"],
    queryFn: async () => (await getDefaultDualLlmConfig()).data ?? null,
    initialData: params?.initialData,
  });
}

export function useUpdateDualLlmConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: {
        enabled?: boolean;
        mainAgentPrompt?: string;
        quarantinedAgentPrompt?: string;
        summaryPrompt?: string;
        maxRounds?: number;
      };
    }) => {
      const response = await updateDualLlmConfig({ path: { id }, body: data });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dual-llm-config"] });
    },
  });
}
