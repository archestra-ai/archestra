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
/** Settings whose saves the other's control waits for. */
type GatedSetting = "mode" | "personApproval";
const MAX_ENFORCED_MARKS = 64;

type Deployment = archestraApiTypes.GetGuardrailsDeploymentResponses[200];
export type GuardrailsMode = Deployment["mode"];
export type PersonApproval = Deployment["personApproval"];

/** What a mode change says, by the mode the saved settings run in. */
export const GUARDRAILS_MODE_TOAST: Record<GuardrailsMode, string> = {
  off: "Guardrails are off.",
  observe: "Guardrails are in Observe.",
  enforce: "Guardrails are in Enforce.",
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
  return useUpdateDeployment((mode: GuardrailsMode) => ({ mode }), {
    successToast: (saved) => GUARDRAILS_MODE_TOAST[saved.mode],
    gatedSetting: "mode",
  });
}

export function useUpdatePersonApproval() {
  return useUpdateDeployment(
    (personApproval: PersonApproval) => ({ personApproval }),
    { gatedSetting: "personApproval" },
  );
}

export function useIsGuardrailsSettingSaving(setting: GatedSetting) {
  return useIsMutating({ mutationKey: mutationKeyOf(setting) }) > 0;
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
      if ("remove" in change)
        return {
          enforcedMarks: marks.filter((mark) => mark !== change.remove),
        };
      if (marks.includes(change.add)) return null;
      if (marks.length >= MAX_ENFORCED_MARKS) {
        const message = `Up to ${MAX_ENFORCED_MARKS} enforced marks.`;
        toast.error(message);
        throw new Error(message);
      }
      return { enforcedMarks: [...marks, change.add] };
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
    { successToast: () => "Annotator model saved" },
  );
}

// ===

function mutationKeyOf(setting: GatedSetting) {
  return [...queryKey, setting];
}

type DeploymentUpdate =
  archestraApiTypes.UpdateGuardrailsDeploymentData["body"];

/**
 * Saves one deployment change; every save toasts the response's warnings. A
 * `null` body is a change already in place, and nothing is sent.
 */
function useUpdateDeployment<TValue>(
  toBody: (
    value: TValue,
  ) => DeploymentUpdate | null | Promise<DeploymentUpdate | null>,
  {
    successToast,
    gatedSetting,
  }: {
    successToast?: (
      saved: archestraApiTypes.UpdateGuardrailsDeploymentResponses[200],
    ) => string;
    gatedSetting?: GatedSetting;
  } = {},
) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: gatedSetting && mutationKeyOf(gatedSetting),
    mutationFn: async (value: TValue) => {
      const body = await toBody(value);
      if (body === null) return undefined;
      const { data, error } = await archestraApiSdk.updateGuardrailsDeployment({
        body,
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
