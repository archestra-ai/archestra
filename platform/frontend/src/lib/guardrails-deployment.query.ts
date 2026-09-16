import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const queryKey = ["guardrails-deployment"];
export function useGuardrailsDeployment() {
  return useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getGuardrailsDeployment();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    refetchInterval: 10000,
  });
}
export function useUpdateGuardrailsDeployment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data, error } = await archestraApiSdk.updateGuardrailsDeployment({
        body: { enabled },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      client.invalidateQueries({ queryKey });
      toast.success(
        data?.active
          ? "Guardrails v2 enabled for all organizations"
          : "Guardrails v2 disabled. Existing guardrails remain active.",
      );
    },
  });
}
