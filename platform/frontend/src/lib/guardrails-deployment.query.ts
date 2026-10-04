import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

const queryKey = ["guardrails-deployment"];
export function useGuardrailsDeployment() {
  const { data: canRead } = useHasPermissions({ organizationSettings: ["read"] });
  return useQuery({
    enabled: canRead === true,
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
          ? "OpenAPPA enforcement is on"
          : "OpenAPPA enforcement is off. Existing guardrails remain active.",
      );
    },
  });
}

export function useUpdateUnsupportedClientAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      unsupportedClientAction: archestraApiTypes.GetGuardrailsDeploymentResponses[200]["unsupportedClientAction"],
    ) => {
      const { data, error } = await archestraApiSdk.updateGuardrailsDeployment({
        body: { unsupportedClientAction },
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
    },
  });
}
