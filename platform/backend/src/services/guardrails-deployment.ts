import { userHasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import { OrganizationModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import UserModel from "@/models/user";
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

type FirstPolicyEnforcement = {
  enabled: boolean;
  turnedOn: boolean;
  reason?: string;
};

/**
 * What saving `revision` leaves the switch at when it does not turn it on
 * (see turnOnForFirstPolicy), or null when it would.
 */
export async function firstPolicyRefusal(
  organizationId: string,
  userId: string | undefined,
  revision: number,
): Promise<FirstPolicyEnforcement | null> {
  const current = await getGuardrailsDeployment();
  if (revision !== 1 || current.enabled || !current.featureEnabled)
    return { enabled: current.active, turnedOn: false };
  if (
    !userId ||
    !(await userHasPermission(userId, organizationId, "organization", "update"))
  )
    return {
      enabled: false,
      turnedOn: false,
      reason:
        "Only an administrator can turn enforcement on, from the OpenAPPA policy page.",
    };
  return null;
}

/**
 * An organization's first saved policy is the one its administrator set out to
 * enforce, so saving it turns OpenAPPA on. "First" is read from the data: the
 * save produced revision 1. Later saves leave the switch to the administrator,
 * and a refusal keeps the saved policy and says why. Audited as the switch's
 * own route audits it. The switch is deployment-wide, so any organization's
 * first saved policy turns it on for every organization; this assumes the
 * usual single-organization deployment.
 */
export async function turnOnForFirstPolicy(params: {
  organizationId: string;
  userId: string;
  revision: number;
}): Promise<FirstPolicyEnforcement> {
  const { organizationId, userId } = params;
  const refusal = await firstPolicyRefusal(
    organizationId,
    userId,
    params.revision,
  );
  if (refusal) return refusal;
  const before = await GuardrailsDeploymentModel.findByIdForAudit();
  try {
    await setGuardrailsDeployment(true);
  } catch (error) {
    if (error instanceof ApiError)
      return { enabled: false, turnedOn: false, reason: error.message };
    throw error;
  }
  const actor = await UserModel.getById(userId);
  await AuditLogModel.create({
    organizationId,
    actorId: userId,
    actorType: "user",
    actorName: actor?.name ?? null,
    actorEmail: actor?.email ?? null,
    action: "organization.updated",
    outcome: "success",
    resourceType: "organization",
    resourceId: organizationId,
    resourceName: null,
    before,
    after: await GuardrailsDeploymentModel.findByIdForAudit(),
    httpMethod: null,
    httpPath: "mcp-tool:update_guardrails_policy",
    httpRoute: null,
    httpStatus: null,
    requestId: null,
    sourceIp: null,
    userAgent: null,
    occurredAt: new Date(),
  }).catch((err) =>
    logger.error({ err }, "audit: failed to record OpenAPPA turning on"),
  );
  return { enabled: true, turnedOn: true };
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
