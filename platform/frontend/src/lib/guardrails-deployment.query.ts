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
 * that show and change the status. Other callers (the sidebar row and warning,
 * the chat composer, Connect) refresh every minute. A tab that stays open then
 * still shows an enforcement change made elsewhere. React Query pauses the
 * interval while the tab is hidden. Nothing loads while OpenAPPA is off.
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

export function useUpdateNewSessionPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      newSessionPolicy: archestraApiTypes.GetGuardrailsDeploymentResponses[200]["newSessionPolicy"],
    ) => {
      const { data, error } = await archestraApiSdk.updateGuardrailsDeployment({
        body: { newSessionPolicy },
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

/** The model and key OpenAPPA's model annotators answer with; both null is the organization default. */
export function useUpdateAnnotatorModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (selection: {
      annotatorModelId: string | null;
      annotatorLlmApiKeyId: string | null;
    }) => {
      const { data, error } = await archestraApiSdk.updateGuardrailsDeployment({
        body: selection,
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
      toast.success("Annotator model saved");
    },
  });
}
