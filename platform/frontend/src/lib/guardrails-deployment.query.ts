import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

const queryKey = ["guardrails-deployment"];
/**
 * `anyMember`: read it without organization settings access. Every member can
 * read the status (the Connect page shows it); other callers keep it to the
 * admins they show it to. `poll`: refresh every 10 s, for the Guardrails pages
 * that show and change it. Everywhere else (the sidebar row and warning, the
 * chat composer, Connect) it refreshes every minute, so an enforcement change
 * made elsewhere still shows up in a tab that stays open; React Query pauses
 * the interval while the tab is hidden. Nothing is fetched while OpenAPPA is
 * off.
 */
export function useGuardrailsDeployment({
  anyMember = false,
  poll = false,
}: {
  anyMember?: boolean;
  poll?: boolean;
} = {}) {
  const openappaEnabled = useFeature("openappaEnabled");
  const { data: canRead } = useHasPermissions({
    organizationSettings: ["read"],
  });
  return useQuery({
    enabled: openappaEnabled === true && (anyMember || canRead === true),
    queryKey,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getGuardrailsDeployment();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    refetchInterval: poll ? 10_000 : 60_000,
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

export function useUpdateBreakTheGlassEnabled() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (breakTheGlassEnabled: boolean) => {
      const { data, error } = await archestraApiSdk.updateGuardrailsDeployment({
        body: { breakTheGlassEnabled },
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
