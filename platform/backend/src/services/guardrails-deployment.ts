import config from "@/config";
import { OrganizationModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError } from "@/types";

/** Read shared state at request boundaries so all replicas see the same switch. */
export async function isGuardrailsV2Active(): Promise<boolean> {
  return (
    config.openappa.enabled && (await GuardrailsDeploymentModel.isEnabled())
  );
}
export async function getGuardrailsDeployment() {
  const enabled = await GuardrailsDeploymentModel.isEnabled();
  return {
    enabled,
    featureEnabled: config.openappa.enabled,
    active: config.openappa.enabled && enabled,
  };
}

/**
 * Turn the deployment-wide switch on or off.
 *
 * Once it is on, every proxied request of every organization opens that
 * organization's policy, and a policy the runtime refuses fails each of them.
 * So the switch turns on only while every organization's latest policy passes
 * the same check a save runs. Turning it off is never refused.
 */
export async function setGuardrailsDeployment(enabled: boolean) {
  if (enabled && config.openappa.enabled) {
    const refusals = await refusedPolicies();
    if (refusals.length > 0)
      throw new ApiError(
        409,
        `Guardrails v2 was not enabled: the guardrails policy is refused, so every proxied request would fail. Fix the policy on the OpenAPPA page first. ${refusals.join(" ")}`,
      );
  }
  await GuardrailsDeploymentModel.setEnabled(enabled);
  return getGuardrailsDeployment();
}

// ===

async function refusedPolicies(): Promise<string[]> {
  const refusals: string[] = [];
  for (const organizationId of await OrganizationModel.findAllIds()) {
    const policy = await guardrailsPolicyService.get(organizationId);
    // Measured against itself: an unchanged include that stopped resolving
    // composes as an empty battery at runtime, so it is a warning here too.
    const { errors } = await guardrailsPolicyService.validate(policy.content, {
      organizationId,
      previous: policy.content,
    });
    if (errors.length > 0)
      refusals.push(`Revision ${policy.revision}: ${errors.join("; ")}`);
  }
  return refusals;
}
