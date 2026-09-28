import config from "@/config";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";

/** The deployment switch selects v2 enforcement; otherwise v1 applies. */
export async function isGuardrailsV2Active(): Promise<boolean> {
  return (
    config.openappa.enabled && (await GuardrailsDeploymentModel.isEnabled())
  );
}
