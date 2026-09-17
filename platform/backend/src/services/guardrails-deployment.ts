import config from "@/config";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";

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
