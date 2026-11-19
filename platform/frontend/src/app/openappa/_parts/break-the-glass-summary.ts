import type { archestraApiTypes } from "@archestra/shared";

type Deployment = Pick<
  archestraApiTypes.GetGuardrailsDeploymentResponses[200],
  "humanApprovalMode" | "unapprovableBlockMode" | "breakTheGlassEnabled"
>;

/**
 * One line per Break the glass setting that lets something through; a setting
 * left blocking says nothing. No lines means Break the glass is off.
 */
export function breakTheGlassSummary(
  deployment: Deployment,
): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  // Same order as Settings: the Yell tool first.
  if (deployment.breakTheGlassEnabled)
    lines.push({
      label: "Yell:",
      value: "turns Guardrails off for the session",
    });
  if (deployment.humanApprovalMode !== "block")
    lines.push({
      label: "Human approval:",
      value:
        deployment.humanApprovalMode === "everywhere"
          ? "waived everywhere"
          : "waived in unattended sessions",
    });
  if (deployment.unapprovableBlockMode === "allow")
    lines.push({
      label: "Other blocked calls:",
      value: "waived",
    });
  return lines;
}
