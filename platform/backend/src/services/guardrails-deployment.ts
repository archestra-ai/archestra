import { userHasPermission } from "@/auth";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import { OrganizationModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import GuardrailsDeploymentModel, {
  type GuardrailsDeploymentUpdate,
} from "@/models/guardrails-deployment";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import UserModel from "@/models/user";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError } from "@/types";
import type {
  GuardrailsMode,
  HumanApprovalMode,
  PersonApproval,
} from "@/types/guardrails-policy";

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
  return getGuardrailsDeploymentFromSnapshot();
}

export async function getGuardrailsDeploymentFromSnapshot(
  snapshot?: Parameters<typeof GuardrailsDeploymentModel.get>[0],
) {
  const row = await GuardrailsDeploymentModel.get(snapshot);
  // An environment variable, while set, wins over the stored setting, and a
  // new setting it pins as well.
  const overrides = config.openappa.breakTheGlassOverrides ?? {};
  const humanApprovalMode =
    overrides.humanApprovalMode ?? row.humanApprovalMode;
  const mode = GuardrailsDeploymentModel.mode(row);
  return {
    mode,
    personApproval:
      (overrides.humanApprovalMode === undefined ? row.personApproval : null) ??
      PERSON_APPROVAL_OF[humanApprovalMode],
    enforcedMarks: row.enforcedMarks ?? [],
    enabled: mode !== "off",
    unsupportedClientAction: row.unsupportedClientAction,
    breakTheGlassEnabled: row.breakTheGlassEnabled,
    humanApprovalMode,
    unapprovableBlockMode:
      overrides.unapprovableBlockMode ?? row.unapprovableBlockMode,
    environmentOverrides: BREAK_THE_GLASS_VARIABLES.filter(
      ({ setting }) => overrides[setting] !== undefined,
    ).flatMap(({ variable, pins }) =>
      pins.map((setting) => ({ setting, variable })),
    ),
    annotatorModelId: row.annotatorModelId,
    annotatorLlmApiKeyId: row.annotatorLlmApiKeyId,
    featureEnabled: enterpriseTier.isOpenappaActive(),
    active: enterpriseTier.isOpenappaActive() && mode !== "off",
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
  update: GuardrailsDeploymentUpdate,
  actor?: { userId: string; organizationId?: string },
  legacy: "closest_tuple" | "as_given" = "closest_tuple",
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
  const stored = await GuardrailsDeploymentModel.get();
  const written =
    legacy === "closest_tuple" ? withClosestTuple(stored, update) : update;
  const turnsOn =
    written.enabled &&
    (update.enabled === true ||
      GuardrailsDeploymentModel.mode(stored) === "off");
  if (turnsOn && enterpriseTier.isOpenappaActive()) {
    const refusals = await refusedPolicies();
    if (refusals.length > 0)
      throw new ApiError(
        409,
        `Guardrails v2 was not enabled: the guardrails policy is refused, so every proxied request would fail. Fix the policy on the OpenAPPA page first. ${refusals.join(" ")}`,
      );
  }
  const before = await getGuardrailsDeploymentFromSnapshot({ row: stored });
  for (const { setting, variable } of before.environmentOverrides) {
    if (update[setting] !== undefined)
      throw new ApiError(
        400,
        `${variable} sets this deployment's ${setting}. Unset it to edit this setting.`,
      );
  }
  await GuardrailsDeploymentModel.set(written);
  const after = await getGuardrailsDeployment();
  // Back on: each repository's policy is pulled now, so what merged while
  // enforcement was off is enforced, not the commit accepted before.
  if (after.enabled && !before.enabled) await queueGitSyncs();
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

/** Queue a pull for every organization whose policy syncs from a repository. */
async function queueGitSyncs() {
  try {
    for (const {
      organizationId,
    } of await OpenAppaGithubSyncModel.findSyncing())
      await OpenAppaGithubSyncModel.enqueue(organizationId);
  } catch (error) {
    // The schedule pulls them anyway; the switch itself has happened.
    logger.warn(
      { error },
      "OpenAPPA could not queue the Git syncs after enforcement turned on",
    );
  }
}

function deploymentSettings(
  deployment: Awaited<ReturnType<typeof getGuardrailsDeployment>>,
) {
  return {
    mode: deployment.mode,
    personApproval: deployment.personApproval,
    enforcedMarks: deployment.enforcedMarks,
    enabled: deployment.enabled,
    active: deployment.active,
    unsupportedClientAction: deployment.unsupportedClientAction,
    breakTheGlassEnabled: deployment.breakTheGlassEnabled,
    humanApprovalMode: deployment.humanApprovalMode,
    unapprovableBlockMode: deployment.unapprovableBlockMode,
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
  const stored = await GuardrailsDeploymentModel.get();
  const current = await getGuardrailsDeploymentFromSnapshot({ row: stored });
  // A mode an administrator saved, Off included, is theirs to change.
  if (
    revision !== 1 ||
    current.enabled ||
    stored.mode !== null ||
    !current.featureEnabled
  )
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
    // Only the switch: the other legacy columns keep what was stored.
    await setGuardrailsDeployment(
      { mode: "enforce", enabled: true },
      { userId, organizationId },
      "as_given",
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

/**
 * The Break the glass settings an environment variable can set, its name, and
 * the settings it pins against edits.
 */
const BREAK_THE_GLASS_VARIABLES = [
  {
    setting: "humanApprovalMode",
    variable: "ARCHESTRA_OPENAPPA_HUMAN_APPROVAL_MODE",
    pins: ["humanApprovalMode", "personApproval"],
  },
  {
    setting: "unapprovableBlockMode",
    variable: "ARCHESTRA_OPENAPPA_SOFT_BLOCK_MODE",
    pins: ["unapprovableBlockMode"],
  },
] as const satisfies readonly {
  setting: keyof GuardrailsDeploymentUpdate;
  variable: string;
  pins: readonly (keyof GuardrailsDeploymentUpdate)[];
}[];

const PERSON_APPROVAL_OF: Record<HumanApprovalMode, PersonApproval> = {
  block: "ask",
  unattended: "auto_unattended",
  everywhere: "auto_everywhere",
};
const HUMAN_APPROVAL_OF: Record<PersonApproval, HumanApprovalMode> = {
  ask: "block",
  auto_unattended: "unattended",
  auto_everywhere: "everywhere",
};

/**
 * What a save writes: a new setting also writes its closest legacy tuple, so
 * older replicas and a rollback behave as close to it as they can; a legacy
 * edit moves a saved new setting along with it.
 */
function withClosestTuple(
  stored: Awaited<ReturnType<typeof GuardrailsDeploymentModel.get>>,
  update: GuardrailsDeploymentUpdate,
): GuardrailsDeploymentUpdate {
  const next = { ...stored, ...update };
  if (update.mode !== undefined || update.personApproval !== undefined)
    return {
      ...update,
      ...legacyTuple(
        GuardrailsDeploymentModel.mode(next),
        next.personApproval ?? PERSON_APPROVAL_OF[next.humanApprovalMode],
      ),
    };
  return {
    ...update,
    ...(update.enabled !== undefined &&
      stored.mode !== null && {
        mode: update.enabled
          ? stored.mode === "off"
            ? "enforce"
            : stored.mode
          : "off",
      }),
    ...(update.humanApprovalMode !== undefined &&
      stored.personApproval !== null && {
        personApproval: PERSON_APPROVAL_OF[update.humanApprovalMode],
      }),
  };
}

function legacyTuple(
  mode: GuardrailsMode,
  personApproval: PersonApproval,
): GuardrailsDeploymentUpdate {
  switch (mode) {
    case "off":
      return { enabled: false };
    case "observe":
      return {
        enabled: true,
        unapprovableBlockMode: "allow",
        humanApprovalMode: "everywhere",
      };
    case "enforce":
      return {
        enabled: true,
        unapprovableBlockMode: "refuse",
        humanApprovalMode: HUMAN_APPROVAL_OF[personApproval],
      };
  }
}
