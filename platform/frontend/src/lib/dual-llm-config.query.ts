import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const { getDefaultDualLlmConfig, updateDualLlmConfig } = archestraApiSdk;

export function useDualLlmConfig(params?: {
  initialData?: archestraApiTypes.GetDefaultDualLlmConfigResponses["200"];
}) {
  return useQuery({
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
        mainProfilePrompt?: string;
        quarantinedProfilePrompt?: string;
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
