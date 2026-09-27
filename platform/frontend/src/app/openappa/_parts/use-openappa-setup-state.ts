import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
import { useGuardrailsPolicy } from "@/lib/guardrails-policy.query";

/**
 * Where OpenAPPA setup stands for the organization. `isFresh` is true when
 * enforcement is off and no policy has been saved, the state a new
 * organization starts in, and undefined until both answers are in.
 */
export function useOpenAppaSetupState() {
  const deployment = useGuardrailsDeployment();
  const policy = useGuardrailsPolicy();
  const enabled = deployment.data?.enabled;
  // Revision 0 is the unsaved starter policy the API answers with.
  const hasPolicy = Boolean(policy.data?.revision);
  const isFresh =
    deployment.isPending || policy.isPending
      ? undefined
      : enabled === false && policy.isSuccess && !hasPolicy;
  return { enabled, hasPolicy, isFresh };
}
