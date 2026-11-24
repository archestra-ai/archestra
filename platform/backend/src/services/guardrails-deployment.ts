import { AsyncLocalStorage } from "node:async_hooks";
import type { GuardrailsSettings, LineRefusal } from "@archestra/openappa-rs";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import { OrganizationModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import GuardrailsDeploymentModel, {
  type GuardrailsDeploymentRow,
  type GuardrailsDeploymentUpdate,
} from "@/models/guardrails-deployment";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import UserModel from "@/models/user";
import { openappaBatteriesService } from "@/openappa/batteries";
import { openappaDeclarations } from "@/openappa/declarations";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError } from "@/types";
import type {
  GuardrailsMode,
  HumanApprovalMode,
  PersonApproval,
} from "@/types/guardrails-policy";
import { mapWithConcurrency } from "@/utils/concurrency";

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
  const { mode, personApproval, enforcedMarks } = canonicalOf(row);
  return {
    mode,
    personApproval: overrides.humanApprovalMode
      ? PERSON_APPROVAL_OF[overrides.humanApprovalMode]
      : personApproval,
    enforcedMarks,
    enabled: mode !== "off",
    unsupportedClientAction: row.unsupportedClientAction,
    breakTheGlassEnabled: row.breakTheGlassEnabled,
    humanApprovalMode: overrides.humanApprovalMode ?? row.humanApprovalMode,
    unapprovableBlockMode:
      overrides.unapprovableBlockMode ?? row.unapprovableBlockMode,
    environmentOverrides: pinnedSettings(),
    annotatorModelId: row.annotatorModelId,
    annotatorLlmApiKeyId: row.annotatorLlmApiKeyId,
    featureEnabled: enterpriseTier.isOpenappaActive(),
    active: enterpriseTier.isOpenappaActive() && mode !== "off",
  };
}

/**
 * The settings a dispatch carries to the runtime, which picks from them the line
 * a session opening now follows.
 */
const requestDispatchSettings = new AsyncLocalStorage<{
  settings?: GuardrailsSettings;
}>();

/** Isolate one proxy request's captured dispatch settings from other requests. */
export function withGuardrailsRequest<T>(run: () => Promise<T>): Promise<T> {
  return requestDispatchSettings.run({}, run);
}

/** The rest of this request dispatches on the settings snapshot it already read. */
export function captureGuardrailsDispatchSettings(
  deployment: Parameters<typeof dispatchSettingsOf>[0],
): void {
  const scope = requestDispatchSettings.getStore();
  if (scope) scope.settings = dispatchSettingsOf(deployment);
}

/**
 * The settings a dispatch sends: the request's captured ones, or a fresh read.
 * `freshMarks` rereads the enforced marks alone, keeping the captured opening
 * mode and person approval, for a retry whose publication refused stale marks.
 */
export async function guardrailsDispatchSettings(options?: {
  freshMarks?: boolean;
}): Promise<GuardrailsSettings> {
  const scope = requestDispatchSettings.getStore();
  if (!scope?.settings)
    return dispatchSettingsOf(await getGuardrailsDeployment());
  if (options?.freshMarks) {
    const { enforcedMarks } = await getGuardrailsDeployment();
    scope.settings = { ...scope.settings, enforcedMarks };
  }
  return scope.settings;
}

/**
 * A dispatch made while Guardrails are off finishes its turn on the Enforce
 * line, asking a person, so no family opens with approvers after the switch.
 */
function dispatchSettingsOf(deployment: {
  mode: GuardrailsMode;
  personApproval: PersonApproval;
  enforcedMarks: string[];
}): GuardrailsSettings {
  const { mode, personApproval, enforcedMarks } = deployment;
  return mode === "off"
    ? { mode: "enforce", personApproval: "ask", enforcedMarks }
    : { mode, personApproval, enforcedMarks };
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
  for (const { setting, variable } of pinnedSettings()) {
    if (update[setting] !== undefined)
      throw new ApiError(
        400,
        `${variable} sets this deployment's ${setting}. Unset it to edit this setting.`,
      );
  }
  const {
    mode: _mode,
    personApproval: _personApproval,
    enforcedMarks: _enforcedMarks,
    enabled: _enabled,
    humanApprovalMode: _humanApprovalMode,
    unapprovableBlockMode: _unapprovableBlockMode,
    ...independent
  } = update;
  // The policy check runs outside the row lock; the locked write refuses a
  // switch-on the check did not cover.
  const checked = turnsOn(await GuardrailsDeploymentModel.get(), update);
  if (checked) await assertPoliciesOpen();
  const stored = await GuardrailsDeploymentModel.save((row) => {
    if (turnsOn(row, update) && !checked)
      throw new ApiError(
        409,
        "The Guardrails settings changed during this save. Try again.",
      );
    const settings = intendedSettings(row, update);
    // A save that names no mode keeps a mode never saved unsaved, so the
    // first published policy still switches enforcement on.
    const keepsUnsaved =
      row.mode === null &&
      update.mode === undefined &&
      update.enabled === undefined;
    return {
      ...independent,
      ...settings,
      ...(keepsUnsaved && { mode: null }),
      ...legacyTuple(settings),
    };
  });
  const before = await getGuardrailsDeploymentFromSnapshot({ row: stored });
  const after = await getGuardrailsDeployment();
  await announceSwitch(before, after, actor?.userId);
  const routing =
    update.mode !== undefined ||
    update.personApproval !== undefined ||
    update.enforcedMarks !== undefined ||
    update.enabled !== undefined ||
    update.humanApprovalMode !== undefined;
  return {
    ...after,
    warnings:
      routing && after.active
        ? await lineWarnings(dispatchSettingsOf(after))
        : [],
  };
}

const LINE_CHECKS_AT_ONCE = 4;
/** How long a settings save waits on its line check before it answers. */
const LINE_CHECK_DEADLINE_MS = 5_000;

export const LINE_CHECK_UNAVAILABLE =
  "The settings are saved, but whether every organization's policy can carry them could not be checked. See the backend log.";

export const LINE_CHECK_INCOMPLETE =
  "The settings are saved, but not every organization's policy was checked before the response was due. The warnings above may not be all of them.";

/**
 * Why a line `settings` open sessions on can't carry its approvers over some
 * organization's served policy, so those sessions follow Enforce instead. The
 * settings are already saved, so a check that fails says so and fails nothing,
 * and one still running at the deadline answers with what it gathered.
 */
export async function lineWarnings(
  settings: GuardrailsSettings,
  deadlineMs = LINE_CHECK_DEADLINE_MS,
): Promise<string[]> {
  const lines = new Set<LineRefusal["variant"]>(
    settings.mode === "observe"
      ? ["observe"]
      : settings.personApproval === "ask"
        ? []
        : ["enforce-approved"],
  );
  if (lines.size === 0) return [];
  const deadline = Date.now() + deadlineMs;
  const gathered = new Set<string>();
  let failed = false;
  let skipped = false;
  const check = async (organizationId: string) => {
    if (Date.now() >= deadline) {
      skipped = true;
      return;
    }
    try {
      const composition =
        await openappaBatteriesService.currentComposition(organizationId);
      // A composition the saved root has moved past would answer for the wrong text.
      if (composition.kind === "stale") skipped = true;
      if (composition.kind !== "served") return;
      const warnings = await openappaDeclarations.lineWarnings(
        composition.content,
        {
          enforcedMarks: settings.enforcedMarks,
          lines,
        },
      );
      for (const warning of warnings) gathered.add(warning);
    } catch (error) {
      failed = true;
      logger.error(
        { err: error, organizationId },
        "Guardrails line check failed",
      );
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    // Settles on its own, so one that loses the race rejects nothing unhandled.
    const scan = async () => {
      try {
        const organizations = await OrganizationModel.findAllIds();
        await mapWithConcurrency(organizations, LINE_CHECKS_AT_ONCE, check);
      } catch (error) {
        failed = true;
        logger.error({ err: error }, "Guardrails line check failed");
      }
      return true;
    };
    const finished = await Promise.race([
      scan(),
      new Promise<false>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
    return [
      ...gathered,
      ...(failed ? [LINE_CHECK_UNAVAILABLE] : []),
      ...(finished && !skipped ? [] : [LINE_CHECK_INCOMPLETE]),
    ];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Back on: each repository's policy is pulled now, so what merged while
 * enforcement was off is enforced, not the commit accepted before. A switch
 * changes what every running session and runtime may do, so the moment it
 * happened must be findable in the backend log, not only in the audit log.
 */
async function announceSwitch(
  before: Awaited<ReturnType<typeof getGuardrailsDeployment>>,
  after: Awaited<ReturnType<typeof getGuardrailsDeployment>>,
  userId: string | undefined,
) {
  if (after.enabled && !before.enabled) await queueGitSyncs();
  logger.info(
    {
      userId,
      before: deploymentSettings(before),
      after: deploymentSettings(after),
    },
    after.enabled !== before.enabled
      ? `Guardrails enforcement switched ${after.enabled ? "on" : "off"}`
      : "Guardrails deployment settings changed",
  );
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
  try {
    if (enterpriseTier.isOpenappaActive()) await assertPoliciesOpen();
  } catch (error) {
    if (error instanceof ApiError)
      return { enabled: false, turnedOn: false, reason: error.message };
    throw error;
  }
  const before = await GuardrailsDeploymentModel.findByIdForAudit();
  // Only the switch, and only while no mode was saved and it is off at the
  // write: an administrator's save in between wins.
  if (!(await GuardrailsDeploymentModel.turnOnIfNeverSet()))
    return {
      enabled: (await getGuardrailsDeployment()).active,
      turnedOn: false,
    };
  await announceSwitch(
    await getGuardrailsDeploymentFromSnapshot({ row: before }),
    await getGuardrailsDeployment(),
    userId,
  );
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

async function assertPoliciesOpen() {
  const refusals = await refusedPolicies();
  if (refusals.length > 0)
    throw new ApiError(
      409,
      `Guardrails v2 was not enabled: the guardrails policy is refused, so every proxied request would fail. Fix the policy on the OpenAPPA page first. ${refusals.join(" ")}`,
    );
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
      lineWarnings: false,
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

type DeploymentSettings = {
  mode: GuardrailsMode;
  personApproval: PersonApproval;
  enforcedMarks: string[];
};

/** Approval strictness, most permissive last. */
const APPROVAL_STRICTNESS: readonly PersonApproval[] = [
  "ask",
  "auto_unattended",
  "auto_everywhere",
];

/**
 * The settings a row holds, without environment overrides. Where a replica of
 * an older release wrote only the legacy columns, the stricter reading wins;
 * under Observe the legacy approval column is Observe's own value, so the
 * saved approval stands.
 */
function canonicalOf(row: GuardrailsDeploymentRow): DeploymentSettings {
  const mode = GuardrailsDeploymentModel.mode(row);
  const legacy = PERSON_APPROVAL_OF[row.humanApprovalMode];
  const saved = row.personApproval ?? legacy;
  return {
    mode,
    personApproval:
      mode === "observe"
        ? saved
        : APPROVAL_STRICTNESS[
            Math.min(
              APPROVAL_STRICTNESS.indexOf(saved),
              APPROVAL_STRICTNESS.indexOf(legacy),
            )
          ],
    enforcedMarks: row.enforcedMarks ?? [],
  };
}

/** The settings a save leaves: its legacy fields read as intent first. */
function intendedSettings(
  row: GuardrailsDeploymentRow,
  update: GuardrailsDeploymentUpdate,
): DeploymentSettings {
  const current = canonicalOf(row);
  const modeFromSwitch =
    update.enabled === undefined
      ? undefined
      : update.enabled
        ? GuardrailsDeploymentModel.mode({ ...row, enabled: true })
        : "off";
  const mode = update.mode ?? modeFromSwitch ?? current.mode;
  // Under Observe the legacy approval column is Observe's own value: it
  // restates it or contradicts it, and never sets the saved approval.
  const approvalFromLegacy =
    mode === "observe" || update.humanApprovalMode === undefined
      ? undefined
      : PERSON_APPROVAL_OF[update.humanApprovalMode];
  const settings: DeploymentSettings = {
    mode,
    personApproval:
      update.personApproval ?? approvalFromLegacy ?? current.personApproval,
    enforcedMarks: update.enforcedMarks ?? current.enforcedMarks,
  };
  const tuple = legacyTuple(settings);
  const conflicts =
    (update.mode !== undefined &&
      update.enabled !== undefined &&
      update.enabled !== (update.mode !== "off")) ||
    (update.personApproval !== undefined &&
      approvalFromLegacy !== undefined &&
      update.personApproval !== approvalFromLegacy) ||
    (mode === "observe" &&
      update.humanApprovalMode !== undefined &&
      update.humanApprovalMode !== tuple.humanApprovalMode) ||
    (update.unapprovableBlockMode !== undefined &&
      update.unapprovableBlockMode !== tuple.unapprovableBlockMode);
  if (conflicts)
    throw new ApiError(
      400,
      "The settings in this request contradict each other",
    );
  return settings;
}

/** Whether a save switches enforcement on, so the policy check must pass. */
function turnsOn(
  row: GuardrailsDeploymentRow,
  update: GuardrailsDeploymentUpdate,
): boolean {
  return (
    enterpriseTier.isOpenappaActive() &&
    intendedSettings(row, update).mode !== "off" &&
    (update.enabled === true || GuardrailsDeploymentModel.mode(row) === "off")
  );
}

/**
 * The legacy columns as a function of the settings, for older replicas and a
 * rollback. Written whole, pinned columns included: what is stored is what
 * the operator chose, and an environment variable only overrides it at read.
 */
function legacyTuple(settings: DeploymentSettings) {
  const observe = settings.mode === "observe";
  return {
    enabled: settings.mode !== "off",
    humanApprovalMode: observe
      ? ("everywhere" as const)
      : HUMAN_APPROVAL_OF[settings.personApproval],
    unapprovableBlockMode: observe ? ("allow" as const) : ("refuse" as const),
  };
}

/** The settings an environment variable sets, and so pins against edits. */
function pinnedSettings() {
  const overrides = config.openappa.breakTheGlassOverrides ?? {};
  return BREAK_THE_GLASS_VARIABLES.filter(
    ({ setting }) => overrides[setting] !== undefined,
  ).flatMap(({ variable, pins }) =>
    pins.map((setting) => ({ setting, variable })),
  );
}
