import config from "@/config";
import type { Transaction } from "@/database";
import { AgentModel, ModelModel } from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingPlanModel from "@/models/routing-plan";
import RoutingUsageModel from "@/models/routing-usage";
import { ApiError, type Model } from "@/types";
import type {
  AutoRoutingSettings,
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
import { type FitSessions, fitNow } from "./fit";
import { activeSourceVersion } from "./signals";
import { sharedLongContextThreshold, TIER_NAMES } from "./tiers";

const TIER_FIELDS = {
  fast: "fastModelId",
  normal: "normalModelId",
  smart: "smartModelId",
} as const;

export async function getAutoRoutingSettings(
  organizationId: string,
): Promise<AutoRoutingSettingsResponse> {
  return describe(
    organizationId,
    await loadAutoRoutingSettings(organizationId),
  );
}

/** Writes `body` with a generation bump if the merged settings are valid, then fits a plan on them. */
export async function updateAutoRoutingSettings(
  organizationId: string,
  body: UpdateAutoRoutingSettingsBody,
): Promise<AutoRoutingSettingsChangeResponse> {
  await AgentModel.getOrgLlmProxy(organizationId);
  await assertTierModels(
    TIER_NAMES.flatMap((tier) => {
      const id = body[TIER_FIELDS[tier]];
      return id === undefined ? [] : [{ tier, id }];
    }),
  );
  const updated = await AutoRoutingSettingsModel.update(
    organizationId,
    {
      enabled: body.enabled,
      budgetUsdPerDay: body.budgetUsdPerDay?.toFixed(2),
      fastModelId: body.fastModelId,
      normalModelId: body.normalModelId,
      smartModelId: body.smartModelId,
    },
    assertValidSettings,
  );
  if (!updated) throw new ApiError(404, "LLM Proxy not found");
  return fitAndDescribe(organizationId, "settings");
}

/** Fits a new plan at the current settings. */
export async function replanAutoRouting(
  organizationId: string,
): Promise<AutoRoutingSettingsChangeResponse> {
  await AgentModel.getOrgLlmProxy(organizationId);
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
    budgetUsdPerDay: Number(plan.budgetUsdPerDay),
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
  // An unexpected fit error records no plan, so only `fit` carries it.
  const lastFitError =
    fit?.status === "failed" ? fit.error : described.status.lastFitError;
  return { ...described, status: { ...described.status, lastFitError }, fit };
}

/** A tier runs agent sessions, so it must chat and call tools — the subagent-tier rule. */
function isTierCandidate(model: Model): boolean {
  return (
    ModelModel.supportsTextChat(model) && model.supportsToolCalling !== false
  );
}

async function assertTierModels(
  tiers: { tier: (typeof TIER_NAMES)[number]; id: string }[],
) {
  const byId = new Map(
    (await ModelModel.findByIds(tiers.map(({ id }) => id))).map((model) => [
      model.id,
      model,
    ]),
  );
  for (const { tier, id } of tiers) {
    const model = byId.get(id);
    if (!model)
      throw new ApiError(400, `The ${tier} tier model does not exist.`);
    if (!isTierCandidate(model)) {
      throw new ApiError(
        400,
        `The ${tier} tier model "${model.provider}/${model.modelId}" is not a tool-capable chat model.`,
      );
    }
  }
}

/** Settings that can be stored: tiers share a long-context threshold, and enabling needs every tier and a budget. */
async function assertValidSettings(
  next: AutoRoutingSettings,
  tx: Transaction,
): Promise<void> {
  const ids = TIER_NAMES.flatMap((tier) => {
    const id = next[TIER_FIELDS[tier]];
    return id === null ? [] : [id];
  });
  const shared = sharedLongContextThreshold(
    await ModelModel.findByIds(ids, tx),
  );
  if (shared.kind === "mismatched") {
    throw new ApiError(
      400,
      `The tier models have different long-context thresholds (${shared.thresholds.join(", ")}). Auto routing needs every tier with long-context prices to use the same threshold.`,
    );
  }
  if (!next.enabled) return;
  const missing = TIER_NAMES.find((tier) => next[TIER_FIELDS[tier]] === null);
  if (missing) {
    throw new ApiError(
      400,
      `Configure the ${missing} tier model before enabling auto routing.`,
    );
  }
  if (next.budgetUsdPerDay === null) {
    throw new ApiError(400, "Set a daily budget before enabling auto routing.");
  }
}

/** `fitted` is the cold-start progress a fit just read, reused when it is for the running scorer version. */
async function describe(
  organizationId: string,
  settings: AutoRoutingSettings,
  fitted: FitSessions | null = null,
): Promise<AutoRoutingSettingsResponse> {
  const tierIds = TIER_NAMES.map((tier) => settings[TIER_FIELDS[tier]]);
  const [models, active, latest, scorerVersion] = await Promise.all([
    ModelModel.findByIds(tierIds.filter((id): id is string => id !== null)),
    RoutingPlanModel.findActive(organizationId),
    RoutingPlanModel.findLatestOutcome(organizationId),
    activeSourceVersion(),
  ]);
  const byId = new Map(models.map((model) => [model.id, model]));
  const tierModel = (id: string | null) => {
    const model = id ? byId.get(id) : undefined;
    return model
      ? { id: model.id, provider: model.provider, modelId: model.modelId }
      : null;
  };
  const [fast, normal, smart] = tierIds.map(tierModel);
  return {
    enabled: settings.enabled,
    budgetUsdPerDay:
      settings.budgetUsdPerDay === null
        ? null
        : Number(settings.budgetUsdPerDay),
    tiers: { fast, normal, smart },
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
            : await RoutingUsageModel.countFitSessions({
                organizationId,
                scorerVersionId: scorerVersion.id,
                inputWatermark: new Date(),
              }),
        required: config.autoRouting.minSessions,
      },
      lastFitError: latest?.status === "failed" ? latest.error : null,
    },
  };
}
