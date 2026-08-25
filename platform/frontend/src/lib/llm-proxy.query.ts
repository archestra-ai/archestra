import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const { getLlmProxy, updateLlmProxy } = archestraApiSdk;

const llmProxyQueryKey = ["llm-proxy"] as const;

/** The organization's LLM Proxy (a singleton, created on first use). */
export function useLlmProxy(params?: { enabled?: boolean }) {
  return useQuery({
    queryKey: llmProxyQueryKey,
    queryFn: async () => {
      const { data, error } = await getLlmProxy();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled: params?.enabled,
  });
}

export function useUpdateLlmProxy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.UpdateLlmProxyData["body"]) => {
      const { data, error } = await updateLlmProxy({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("LLM Proxy updated");
      queryClient.setQueryData(llmProxyQueryKey, data);
      queryClient.invalidateQueries({ queryKey: llmProxyQueryKey });
    },
  });
}
