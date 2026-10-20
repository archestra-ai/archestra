import { userHasPermission } from "@/auth";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import { OrganizationModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import UserModel from "@/models/user";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError } from "@/types";
import type { UnsupportedAppaClientAction } from "@/types/guardrails-policy";

export type GuardrailsV2Activation = "active" | "inactive";

/**
 * One read of the admin switch for every channel.
 * A failed read throws. Callers must not treat that as the switch being off.
 */
export async function readGuardrailsV2Activation(
  readEnabled: () => Promise<boolean> = () =>
    GuardrailsDeploymentModel.isEnabled(),
): Promise<GuardrailsV2Activation> {
  if (!enterpriseTier.isOpenappaActive()) return "inactive";
  return (await readEnabled()) ? "active" : "inactive";
}

/** Read shared state at request boundaries so all replicas see the same switch. */
export async function isGuardrailsV2Active(): Promise<boolean> {
  return (await readGuardrailsV2Activation()) === "active";
}
export async function getGuardrailsDeployment() {
  const {
    enabled,
    unsupportedClientAction,
    breakTheGlassEnabled,
    annotatorModelId,
    annotatorLlmApiKeyId,
  } = await GuardrailsDeploymentModel.get();
  return {
    enabled,
    unsupportedClientAction,
    breakTheGlassEnabled,
    annotatorModelId,
    annotatorLlmApiKeyId,
    featureEnabled: enterpriseTier.isOpenappaActive(),
    active: enterpriseTier.isOpenappaActive() && enabled,
  };
}

/**
 * Whether a yell also turns OpenAPPA off for the session that sends it:
 * enforcement is on and an administrator left break the glass on in
 * Guardrails settings.
 */
export function breakTheGlassActiveIn(deployment: {
  active: boolean;
  breakTheGlassEnabled: boolean;
}): boolean {
  return deployment.active && deployment.breakTheGlassEnabled;
}

/**
 * Turn the deployment-wide switch on or off.
 *
 * Once it is on, every proxied request of every organization opens that
 * organization's policy, and a policy the runtime refuses fails each of them.
 * So the switch turns on only while every organization's latest policy passes
 * the same check a save runs. Turning it off is never refused.
 */
export async function setGuardrailsDeployment(
  update: {
    enabled?: boolean;
    unsupportedClientAction?: UnsupportedAppaClientAction;
    breakTheGlassEnabled?: boolean;
    annotatorModelId?: string | null;
    annotatorLlmApiKeyId?: string | null;
  },
  actor?: { userId: string; organizationId?: string },
) {
  if (
    update.annotatorModelId !== undefined ||
    update.annotatorLlmApiKeyId !== undefined
  )
    await assertAnnotatorModelSelection({
      organizationId: actor?.organizationId,
      modelId: update.annotatorModelId ?? null,
      apiKeyId: update.annotatorLlmApiKeyId ?? null,
    });
  if (update.enabled && enterpriseTier.isOpenappaActive()) {
    const refusals = await refusedPolicies();
    if (refusals.length > 0)
      throw new ApiError(
        409,
        `Guardrails v2 was not enabled: the guardrails policy is refused, so every proxied request would fail. Fix the policy on the OpenAPPA page first. ${refusals.join(" ")}`,
      );
  }
  const before = await getGuardrailsDeployment();
  await GuardrailsDeploymentModel.set(update);
  const after = await getGuardrailsDeployment();
  // A switch changes what every running session and runtime may do, so the
  // moment it happened must be findable in the backend log, not only in the
  // audit log.
  logger.info(
    {
      userId: actor?.userId,
      before: deploymentSettings(before),
      after: deploymentSettings(after),
    },
    after.enabled !== before.enabled
      ? `Guardrails enforcement switched ${after.enabled ? "on" : "off"}`
      : "Guardrails deployment settings changed",
  );
  return after;
}

function deploymentSettings(
  deployment: Awaited<ReturnType<typeof getGuardrailsDeployment>>,
) {
  return {
    enabled: deployment.enabled,
    active: deployment.active,
    unsupportedClientAction: deployment.unsupportedClientAction,
    breakTheGlassEnabled: deployment.breakTheGlassEnabled,
    annotatorModelId: deployment.annotatorModelId,
    annotatorLlmApiKeyId: deployment.annotatorLlmApiKeyId,
  };
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
    !(await userHasPermission(
      userId,
      organizationId,
      "organizationSettings",
      "update",
    ))
  )
    return {
      enabled: false,
      turnedOn: false,
      reason:
        "Turning enforcement on needs permission to update organization settings. Ask an administrator to turn it on from the OpenAPPA overview.",
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
    await setGuardrailsDeployment(
      { enabled: true },
      { userId, organizationId },
    );
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

/**
 * The annotator model and its key are a pair: both set, the key the
 * organization's and the model one it serves, or both null for the
 * organization's default model.
 */
async function assertAnnotatorModelSelection(params: {
  organizationId: string | undefined;
  modelId: string | null;
  apiKeyId: string | null;
}): Promise<void> {
  const { organizationId, modelId, apiKeyId } = params;
  if (!modelId && !apiKeyId) return;
  if (!modelId || !apiKeyId)
    throw new ApiError(
      400,
      "The annotator model and API key must be set together",
    );
  const apiKey = await LlmProviderApiKeyModel.findById(apiKeyId);
  if (!apiKey || apiKey.organizationId !== organizationId)
    throw new ApiError(404, "API key not found");
  const linked = (
    await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([apiKey.id])
  ).some(({ model }) => model.id === modelId);
  if (!linked)
    throw new ApiError(400, "The annotator model and API key must be linked");
}

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
