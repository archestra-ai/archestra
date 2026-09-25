import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  guardrailsPolicyQueryKey,
  invalidatePolicyViews,
} from "@/lib/openappa-policy-views";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type GuardrailsPolicy =
  archestraApiTypes.GetGuardrailsPolicyResponses["200"];

export function useGuardrailsPolicy() {
  return useQuery({
    queryKey: guardrailsPolicyQueryKey,
    refetchInterval: 10000,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getGuardrailsPolicy();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useValidateGuardrailsPolicy() {
  return useMutation({
    mutationFn: async (content: string) => {
      const { data, error } = await archestraApiSdk.validateGuardrailsPolicy({
        body: { content },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
  });
}

export function useUpdateGuardrailsPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.UpdateGuardrailsPolicyData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.updateGuardrailsPolicy({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      client.setQueryData(guardrailsPolicyQueryKey, data);
      toast.success("Policy saved. Applies to new conversations.");
    },
    // The text declares the batteries: a save moves what they compose to.
    onSettled: () => invalidatePolicyViews(client),
  });
}
