import config from "@/config";
import type { Transaction } from "@/database";
import {
  AgentModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import AutoRoutingSettingsModel, {
  mergeSettings,
} from "@/models/auto-routing-settings";
import RoutingPlanModel from "@/models/routing-plan";
import { ApiError } from "@/types";
import type {
  AutoRoutingSettings,
  AutoRoutingTierSetting,
  RoutingPlanRecord,
  RoutingPlanTrigger,
} from "@/types/auto-routing";
import type {
  AutoRoutingPlanDetail,
  AutoRoutingPlanSummary,
  AutoRoutingSettingsChangeResponse,
  AutoRoutingSettingsResponse,
  UpdateAutoRoutingSettingsBody,
} from "@/types/auto-routing-api";
import { scanOnFirstEnable } from "./backfill";
import {
  type FitSessions,
  fitInputsUnchanged,
  fitNow,
  infeasibleBudget,
  readFitWindow,
} from "./fit";
import { activeSourceVersion } from "./signals";
import { scorerState } from "./signals/jev-session";
import { sharedLongContextThreshold, TIER_NAMES } from "./tiers";

const TIER_FIELDS = {
  fast: "fastModelId",
  normal: "normalModelId",
  smart: "smartModelId",
} as const;

const TIER_KEY_FIELDS = {
  fast: "fastApiKeyId",
  normal: "normalApiKeyId",
  smart: "smartApiKeyId",
} as const;

export async function getAutoRoutingSettings(
  organizationId: string,
): Promise<AutoRoutingSettingsResponse> {
  return describe(
    organizationId,
    await loadAutoRoutingSettings(organizationId),
  );
}

/**
 * Writes `body` with a generation bump if the merged settings are valid and
 * their budget can be met on the current usage, then fits a plan on them.
 */
export async function updateAutoRoutingSettings(
  organizationId: string,
  body: UpdateAutoRoutingSettingsBody,
): Promise<AutoRoutingSettingsChangeResponse> {
  await AgentModel.getOrgLlmProxy(organizationId);
  if (body.tiers) await assertValidTiers(organizationId, body.tiers);
  const update = {
    enabled: body.enabled,
    budgetUsdPerDay: body.budgetUsdPerDay?.toFixed(2),
    // A custom budget sent on its own replaces the preset.
    budgetPreset:
      body.budgetPreset !== undefined
        ? body.budgetPreset
        : body.budgetUsdPerDay !== undefined
          ? null
          : undefined,
    tiers: body.tiers,
  };
  // The feasibility fit runs outside the routing-plan lock; the write then
  // applies only over the settings it checked, retrying when they moved.
  let updated: AutoRoutingSettings | null = null;
  for (let attempt = 0; !updated; attempt++) {
    if (attempt === UPDATE_ATTEMPTS) {
      throw new ApiError(
        409,
        "Auto routing settings changed concurrently; try again.",
      );
    }
    const checked = await loadAutoRoutingSettings(organizationId);
    await assertFeasibleBudget(organizationId, mergeSettings(checked, update));
    updated = await AutoRoutingSettingsModel.update(
      organizationId,
      update,
      async (next, tx, current) => {
        if (current.generation !== checked.generation) throw SETTINGS_MOVED;
        await assertValidSettings(next, tx);
      },
    ).catch((error) => {
      if (error === SETTINGS_MOVED) return null;
      throw error;
    });
  }
  if (updated.enabled) await scanOnFirstEnable(organizationId);
  return fitAndDescribe(organizationId, "settings");
}

/** Fits a new plan at the current settings, unless the active plan was fitted on exactly what a fit would read now. */
export async function replanAutoRouting(
  organizationId: string,
): Promise<AutoRoutingSettingsChangeResponse> {
  const settings = await loadAutoRoutingSettings(organizationId);
  const active = settings.enabled
    ? await RoutingPlanModel.findActive(organizationId)
    : null;
  if (active && (await fitInputsUnchanged(organizationId, settings, active))) {
    return {
      ...(await describe(organizationId, settings)),
      fit: { status: "unchanged", planId: active.id },
    };
  }
  const updated = await AutoRoutingSettingsModel.update(organizationId, {});
  if (!updated) throw new ApiError(404, "LLM Proxy not found");
  return fitAndDescribe(organizationId, "manual");
}

export function toPlanSummary(
  record: RoutingPlanRecord,
): AutoRoutingPlanSummary {
  const { plan } = record;
  return {
    id: plan.id,
    createdAt: plan.createdAt,
    trigger: plan.trigger,
    status: plan.status,
    generation: plan.generation,
    inputWatermark: plan.inputWatermark,
    budgetUsdPerDay:
      plan.budgetUsdPerDay === null ? null : Number(plan.budgetUsdPerDay),
    scorerVersion: record.scorerVersion,
    coreVersion: plan.coreVersion,
    planFormatVersion: plan.planFormatVersion,
    summary: plan.summary,
    diagnostics: plan.diagnostics,
    error: plan.error,
    decisionCount: record.decisionCount,
  };
}

export function toPlanDetail(record: RoutingPlanRecord): AutoRoutingPlanDetail {
  return {
    ...toPlanSummary(record),
    tiersFingerprint: record.plan.tiersFingerprint,
    plan: record.plan.plan,
  };
}

// === Internal ===

const UPDATE_ATTEMPTS = 3;
const SETTINGS_MOVED = Symbol("settings moved");

/** The organization's settings; its LLM Proxy row is created on first use. */
export async function loadAutoRoutingSettings(
  organizationId: string,
): Promise<AutoRoutingSettings> {
  await AgentModel.getOrgLlmProxy(organizationId);
  const settings = await AutoRoutingSettingsModel.find(organizationId);
  if (!settings) throw new ApiError(404, "LLM Proxy not found");
  return settings;
}

async function fitAndDescribe(
  organizationId: string,
  trigger: RoutingPlanTrigger,
): Promise<AutoRoutingSettingsChangeResponse> {
  // prepareFit activates the scorer version, which must not bump a disabled organization.
  const { enabled } = await loadAutoRoutingSettings(organizationId);
  const inline = enabled ? await fitNow(organizationId, trigger) : null;
  const fit = inline?.fit ?? null;
  const described = await describe(
    organizationId,
    await loadAutoRoutingSettings(organizationId),
    inline?.sessions ?? null,
  );
  // An error before the fit recorded an outcome leaves no plan, so only `fit` carries it.
  const lastFitError =
    fit?.status === "failed" ? fit.error : described.status.lastFitError;
  return { ...described, status: { ...described.status, lastFitError }, fit };
}

/** Enabled settings need every tier, one long-context threshold across the tiers, and a budget or a preset. */
async function assertValidSettings(
  next: AutoRoutingSettings,
  tx: Transaction,
): Promise<void> {
  if (!next.enabled) return;
  const ids = TIER_NAMES.flatMap((tier) => {
    const id = next[TIER_FIELDS[tier]];
    return id === null ? [] : [id];
  });
  const models = await ModelModel.findByIds(ids, tx);
  const unfit = models.find(
    (model) =>
      !ModelModel.supportsTextChat(model) ||
      model.supportsToolCalling === false,
  );
  if (unfit) {
    throw new ApiError(
      400,
      `Auto routing tier "${unfit.provider}/${unfit.modelId}" is not a tool-capable chat model.`,
    );
  }
  const shared = sharedLongContextThreshold(models);
  if (shared.kind === "mismatched") {
    throw new ApiError(
      400,
      `The tier models have different long-context thresholds (${shared.thresholds.join(", ")}). Auto routing needs every tier with long-context prices to use the same threshold.`,
    );
  }
  const missing = TIER_NAMES.find((tier) => next[TIER_FIELDS[tier]] === null);
  if (missing) {
    throw new ApiError(
      400,
      `Choose a ${missing} model before turning auto routing on.`,
    );
  }
  if (next.budgetUsdPerDay === null && next.budgetPreset === null) {
    throw new ApiError(400, "Set a daily budget before enabling auto routing.");
  }
}

/**
 * Each tier's key belongs to the organization, is shared with all of it (every
 * chat and agent on `auto` runs on it) and serves the tier's model.
 */
async function assertValidTiers(
  organizationId: string,
  tiers: Record<(typeof TIER_NAMES)[number], AutoRoutingTierSetting>,
): Promise<void> {
  const settings = TIER_NAMES.map((tier) => ({ tier, ...tiers[tier] }));
  const [keys, models, organizationWide] = await Promise.all([
    LlmProviderApiKeyModel.findByIds(settings.map((t) => t.providerApiKeyId)),
    ModelModel.findByIds(settings.map((t) => t.modelId)),
    LlmProviderApiKeyModel.findOrganizationWideKeyIds(organizationId),
  ]);
  for (const { tier, providerApiKeyId, modelId } of settings) {
    const key = keys.find((candidate) => candidate.id === providerApiKeyId);
    const model = models.find((candidate) => candidate.id === modelId);
    if (!key || key.organizationId !== organizationId) {
      throw new ApiError(400, `The ${tier} tier's key was not found.`);
    }
    if (!model) {
      throw new ApiError(400, `The ${tier} tier's model was not found.`);
    }
    if (!organizationWide.includes(key.id)) {
      throw new ApiError(
        400,
        `The ${tier} tier's key "${key.name}" is not shared with the whole organization. Auto routing runs every chat and agent on its tiers' keys.`,
      );
    }
    const linked = await LlmProviderApiKeyModelLinkModel.filterLinkedModelIds({
      apiKeyIds: [key.id],
      modelIds: [model.id],
    });
    if (!linked.has(model.id)) {
      throw new ApiError(
        400,
        `The key "${key.name}" does not serve "${model.provider}/${model.modelId}" (${tier} tier).`,
      );
    }
  }
}

/** Runs a fit on `next` that publishes nothing, so a budget the trio cannot meet is never stored. */
async function assertFeasibleBudget(
  organizationId: string,
  next: AutoRoutingSettings,
): Promise<void> {
  const cheapest = await infeasibleBudget(organizationId, next);
  if (cheapest === null) return;
  // Rounded up, so the amount shown is itself enough.
  const minimum = (Math.ceil(cheapest * 100) / 100).toFixed(2);
  throw new ApiError(
    400,
    `Budget too low for these models: the cheapest routing costs $${minimum}/day.`,
  );
}

/** `fitted` is the cold-start progress a fit just read, reused when it is for the running scorer version. */
async function describe(
  organizationId: string,
  settings: AutoRoutingSettings,
  fitted: FitSessions | null = null,
): Promise<AutoRoutingSettingsResponse> {
  const tierIds = TIER_NAMES.map((tier) => settings[TIER_FIELDS[tier]]);
  const tierKeyIds = TIER_NAMES.map((tier) => settings[TIER_KEY_FIELDS[tier]]);
  const [
    models,
    keys,
    active,
    latest,
    scorerVersion,
    scorer,
    scorerKey,
    agentCount,
    organization,
    eligibleApiKeyIds,
  ] = await Promise.all([
    ModelModel.findByIds(tierIds.filter((id): id is string => id !== null)),
    LlmProviderApiKeyModel.findByIds(
      tierKeyIds.filter((id): id is string => id !== null),
    ),
    RoutingPlanModel.findActive(organizationId),
    RoutingPlanModel.findLatestOutcome(organizationId),
    activeSourceVersion(),
    scorerState(organizationId),
    LlmProviderApiKeyModel.findOrganizationWideKey(organizationId, "jev"),
    AgentModel.countOnAutoModel(organizationId),
    OrganizationModel.getById(organizationId),
    LlmProviderApiKeyModel.findOrganizationWideKeyIds(organizationId),
  ]);
  const tierSetting = (index: number) => {
    const model = models.find((candidate) => candidate.id === tierIds[index]);
    const key = keys.find((candidate) => candidate.id === tierKeyIds[index]);
    return model && key
      ? {
          id: model.id,
          provider: model.provider,
          modelId: model.modelId,
          apiKey: { id: key.id, name: key.name },
        }
      : null;
  };
  const [fast, normal, smart] = TIER_NAMES.map((_, index) =>
    tierSetting(index),
  );
  return {
    enabled: settings.enabled,
    budgetUsdPerDay:
      settings.budgetUsdPerDay === null
        ? null
        : Number(settings.budgetUsdPerDay),
    budgetPreset: settings.budgetPreset,
    tiers: { fast, normal, smart },
    eligibleApiKeyIds,
    usage: {
      agentCount,
      organizationDefault: organization?.defaultAutoModel ?? false,
    },
    generation: settings.generation,
    plannedGeneration: settings.plannedGeneration,
    status: {
      activePlan: active
        ? { id: active.id, createdAt: active.createdAt }
        : null,
      coldStart: {
        scorerVersionId: scorerVersion.id,
        sessions:
          fitted?.scorerVersionId === scorerVersion.id
            ? fitted.sessions
            : (
                await readFitWindow({
                  organizationId,
                  scorerVersionId: scorerVersion.id,
                  inputWatermark: new Date(),
                })
              ).sessions,
        required: config.autoRouting.minSessions,
      },
      lastFitError: latest?.status === "failed" ? latest.error : null,
      scorer,
      scorerApiKey: scorerKey
        ? { id: scorerKey.id, name: scorerKey.name }
        : null,
    },
  };
}
