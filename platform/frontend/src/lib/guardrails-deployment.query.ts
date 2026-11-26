import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { throwOnApiError } from "@/lib/utils/api";

export const guardrailsDeploymentQueryKey = ["guardrails-deployment"];
const queryKey = guardrailsDeploymentQueryKey;
const modeMutationKey = [...queryKey, "mode"];

type Deployment = archestraApiTypes.GetGuardrailsDeploymentResponses[200];
export type GuardrailsMode = Deployment["mode"];
export type PersonApproval = Deployment["personApproval"];

/** What a mode change says, by the mode the saved settings run in. */
export const GUARDRAILS_MODE_TOAST: Record<GuardrailsMode, string> = {
  off: "Guardrails are off. Your policy isn't applied, so agents can call any tool.",
  observe:
    "Guardrails are on in Observe. Every tool call is checked and recorded, and the platform applies remedies for the agent where it can.",
  enforce:
    "Guardrails are on in Enforce. Every tool call is checked against your policy before it runs.",
};
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
export function useUpdateGuardrailsMode() {
  return useUpdateDeployment(
    (mode: GuardrailsMode) => ({ mode }),
    (saved) => GUARDRAILS_MODE_TOAST[saved.mode],
    modeMutationKey,
  );
}

export function useIsGuardrailsModeUpdating() {
  return useIsMutating({ mutationKey: modeMutationKey }) > 0;
}

export function useUpdatePersonApproval() {
  return useUpdateDeployment((personApproval: PersonApproval) => ({
    personApproval,
  }));
}

/**
 * Applies the change to the list as saved now, not as the page last read it,
 * so a mark saved elsewhere meanwhile is kept.
 */
export function useUpdateEnforcedMarks() {
  return useUpdateDeployment(
    async (change: { add: string } | { remove: string }) => {
      const { data, error } = await archestraApiSdk.getGuardrailsDeployment();
      throwOnApiError(error);
      if (!data) throw new Error("Guardrails settings were not returned");
      const marks = data.enforcedMarks;
      return {
        enforcedMarks:
          "add" in change
            ? marks.includes(change.add)
              ? marks
              : [...marks, change.add]
            : marks.filter((mark) => mark !== change.remove),
      };
    },
  );
}

export function useUpdateUnsupportedClientAction() {
  return useUpdateDeployment(
    (unsupportedClientAction: Deployment["unsupportedClientAction"]) => ({
      unsupportedClientAction,
    }),
  );
}

/** The model and key OpenAPPA's model annotators answer with; both null is the organization default. */
export function useUpdateAnnotatorModel() {
  return useUpdateDeployment(
    (
      selection: Pick<Deployment, "annotatorModelId" | "annotatorLlmApiKeyId">,
    ) => selection,
    () => "Annotator model saved",
  );
}

// ===

/** Saves one deployment change; every save toasts the response's warnings. */
function useUpdateDeployment<TValue>(
  toBody: (
    value: TValue,
  ) =>
    | archestraApiTypes.UpdateGuardrailsDeploymentData["body"]
    | Promise<archestraApiTypes.UpdateGuardrailsDeploymentData["body"]>,
  successToast?: (
    saved: archestraApiTypes.UpdateGuardrailsDeploymentResponses[200],
  ) => string,
  mutationKey?: readonly unknown[],
) {
  const client = useQueryClient();
  return useMutation({
    mutationKey,
    mutationFn: async (value: TValue) => {
      const { data, error } = await archestraApiSdk.updateGuardrailsDeployment({
        body: await toBody(value),
      });
      throwOnApiError(error);
      return data;
    },
    onSuccess: (data) => {
      if (data) {
        if (successToast) toast.success(successToast(data));
        for (const warning of data.warnings) toast.warning(warning);
      }
      // A refetch, not the response, so a slower save cannot roll the cache back.
      return client.invalidateQueries({ queryKey });
    },
  });
}
