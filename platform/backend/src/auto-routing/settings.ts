import config from "@/config";
import type { Transaction } from "@/database";
import {
  AgentModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import AutoRouterModel, { mergeRouter } from "@/models/auto-router";
import RoutingPlanModel from "@/models/routing-plan";
import { JEV_MODELS } from "@/routes/chat/model-fetchers/jev";
import { ApiError } from "@/types";
import type {
  AutoRouter,
  AutoRoutingTierSetting,
  RoutingPlanRecord,
  RoutingPlanTrigger,
  UpdateAutoRouter,
} from "@/types/auto-routing";
import type {
  AutoRouterChangeResponse,
  AutoRouterResponse,
  AutoRoutingPlanDetail,
  AutoRoutingPlanSummary,
  AutoRoutingStateResponse,
  CreateAutoRouterBody,
  UpdateAutoRouterBody,
} from "@/types/auto-routing-api";
import { scanOnFirstEnable } from "./backfill";
import {
  type FitSessions,
  fitInputsUnchanged,
  fitNow,
  infeasibleBudget,
  readFitWindow,
} from "./fit";
import { activeSourceVersion, DEFAULT_SCORER_MODEL } from "./signals";
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

/** The provider whose models score sessions today; a router's decision key is one of its keys. */
const DECISIONS_PROVIDER = "jev";

/** The organization's switch and what its routers may be built from. */
export async function getAutoRoutingState(
  organizationId: string,
): Promise<AutoRoutingStateResponse> {
  const [organization, eligibleApiKeyIds] = await Promise.all([
    OrganizationModel.getById(organizationId),
    LlmProviderApiKeyModel.findOrganizationWideKeyIds(organizationId),
  ]);
  const keys = await LlmProviderApiKeyModel.findByIds(eligibleApiKeyIds);
  return {
    enabled: organization?.autoRoutingEnabled ?? false,
    eligibleApiKeyIds,
    decisionProviders: [
      {
        provider: DECISIONS_PROVIDER,
        models: JEV_MODELS,
        apiKeys: keys
          .filter((key) => key.provider === DECISIONS_PROVIDER)
          .map((key) => ({ id: key.id, name: key.name })),
      },
    ],
  };
}

/**
 * Turns every router of the organization on or off. Turning it on scans the
 * organization's past sessions once for the router that learns from them; the
 * dispatcher fits each configured router within a minute.
 */
export async function setAutoRoutingEnabled(
  organizationId: string,
  enabled: boolean,
): Promise<AutoRoutingStateResponse> {
  await OrganizationModel.patch(organizationId, {
    autoRoutingEnabled: enabled,
  });
  if (enabled && (await AutoRouterModel.findPastSessionsRouter(organizationId)))
    await scanOnFirstEnable(organizationId);
  return getAutoRoutingState(organizationId);
}

export async function listAutoRouters(
  organizationId: string,
): Promise<AutoRouterResponse[]> {
  const routers = await AutoRouterModel.list(organizationId);
  const context = await describeContext(organizationId, routers);
  return Promise.all(routers.map((router) => describe(router, context)));
}

export async function getAutoRouter(
  organizationId: string,
  routerId: string,
): Promise<AutoRouterResponse> {
  return describeOne(await loadAutoRouter(organizationId, routerId));
}

/** Creates a complete router, which starts cold: it learns from its own sessions only. */
export async function createAutoRouter(
  organizationId: string,
  body: CreateAutoRouterBody,
): Promise<AutoRouterChangeResponse> {
  await assertValidTiers(organizationId, body.tiers);
  if (body.decisionModel) {
    await assertValidDecisionKey(organizationId, body.decisionModel.apiKeyId);
  }
  if (await AutoRouterModel.findByName(organizationId, body.name)) {
    throw new ApiError(409, `An auto router named "${body.name}" exists.`);
  }
  const created = await AutoRouterModel.create(
    organizationId,
    {
      name: body.name,
      budgetUsdPerDay: body.budgetUsdPerDay?.toFixed(2),
      budgetPreset: body.budgetPreset ?? null,
      scorerApiKeyId: body.decisionModel?.apiKeyId ?? null,
      scorerModel: body.decisionModel?.model ?? DEFAULT_SCORER_MODEL,
      tiers: body.tiers,
    },
    assertValidRouter,
  );
  return fitAndDescribe(created.id, "initial");
}

/**
 * Writes `body` with a generation bump if the merged router is valid and its
 * budget can be met on the current usage, then fits a plan on it.
 */
export async function updateAutoRouter(
  organizationId: string,
  routerId: string,
  body: UpdateAutoRouterBody,
): Promise<AutoRouterChangeResponse> {
  if (body.tiers) await assertValidTiers(organizationId, body.tiers);
  if (body.decisionModel) {
    await assertValidDecisionKey(organizationId, body.decisionModel.apiKeyId);
  }
  const update: UpdateAutoRouter = {
    name: body.name,
    budgetUsdPerDay: body.budgetUsdPerDay?.toFixed(2),
    // A custom budget sent on its own replaces the preset.
    budgetPreset:
      body.budgetPreset !== undefined
        ? body.budgetPreset
        : body.budgetUsdPerDay !== undefined
          ? null
          : undefined,
    scorerApiKeyId: body.decisionModel?.apiKeyId,
    scorerModel: body.decisionModel?.model,
    tiers: body.tiers,
  };
  // The feasibility fit runs outside the routing-plan lock; the write then
  // applies only over the router it checked, retrying when it moved.
  let updated: AutoRouter | null = null;
  for (let attempt = 0; !updated; attempt++) {
    if (attempt === UPDATE_ATTEMPTS) {
      throw new ApiError(
        409,
        "The auto router changed concurrently; try again.",
      );
    }
    const checked = await loadAutoRouter(organizationId, routerId);
    if (body.name !== undefined && body.name !== checked.name) {
      const taken = await AutoRouterModel.findByName(organizationId, body.name);
      if (taken) {
        throw new ApiError(409, `An auto router named "${body.name}" exists.`);
      }
    }
    await assertFeasibleBudget(mergeRouter(checked, update));
    updated = await AutoRouterModel.update(
      routerId,
      update,
      async (next, tx, current) => {
        if (current.generation !== checked.generation) throw ROUTER_MOVED;
        await assertValidRouter(next, tx);
      },
    ).catch((error) => {
      if (error === ROUTER_MOVED) return null;
      throw error;
    });
    if (!updated) await loadAutoRouter(organizationId, routerId);
  }
  return fitAndDescribe(routerId, "settings");
}

/**
 * Deletes the router with what it learned. Agents, chats and the organization
 * default set to it fall back to their own model.
 */
export async function deleteAutoRouter(
  organizationId: string,
  routerId: string,
): Promise<void> {
  if (!(await AutoRouterModel.delete(organizationId, routerId))) {
    throw new ApiError(404, "Auto router not found");
  }
  await OrganizationModel.invalidateSettingsCaches(organizationId);
}

/** Fits a new plan at the router's current settings, unless the active plan was fitted on exactly what a fit would read now. */
export async function replanAutoRouter(
  organizationId: string,
  routerId: string,
): Promise<AutoRouterChangeResponse> {
  const router = await loadAutoRouter(organizationId, routerId);
  const active = router.enabled
    ? await RoutingPlanModel.findActive(routerId)
    : null;
  if (active && (await fitInputsUnchanged(router, active))) {
    return {
      ...(await describeOne(router)),
      fit: { status: "unchanged", planId: active.id },
    };
  }
  const updated = await AutoRouterModel.update(routerId, {});
  if (!updated) throw new ApiError(404, "Auto router not found");
  return fitAndDescribe(routerId, "manual");
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

/** The organization's router, or a 404. */
export async function loadAutoRouter(
  organizationId: string,
  routerId: string,
): Promise<AutoRouter> {
  const router = await AutoRouterModel.findInOrganization(
    organizationId,
    routerId,
  );
  if (!router) throw new ApiError(404, "Auto router not found");
  return router;
}

// === Internal ===

const UPDATE_ATTEMPTS = 3;
const ROUTER_MOVED = Symbol("router moved");

async function fitAndDescribe(
  routerId: string,
  trigger: RoutingPlanTrigger,
): Promise<AutoRouterChangeResponse> {
  const before = await AutoRouterModel.find(routerId);
  if (!before) throw new ApiError(404, "Auto router not found");
  // prepareFit activates the scorer version, which must not bump a router that is off.
  const inline = before.enabled ? await fitNow(routerId, trigger) : null;
  const fit = inline?.fit ?? null;
  const after = await AutoRouterModel.find(routerId);
  if (!after) throw new ApiError(404, "Auto router not found");
  const described = await describeOne(after, inline?.sessions ?? null);
  // An error before the fit recorded an outcome leaves no plan, so only `fit` carries it.
  const lastFitError =
    fit?.status === "failed" ? fit.error : described.status.lastFitError;
  return { ...described, status: { ...described.status, lastFitError }, fit };
}

/** A router needs every tier, tool-capable chat models, one long-context threshold across them, and a budget or a preset. */
async function assertValidRouter(
  next: AutoRouter,
  tx: Transaction,
): Promise<void> {
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
    throw new ApiError(400, `Choose a ${missing} model for the auto router.`);
  }
  if (next.budgetUsdPerDay === null && next.budgetPreset === null) {
    throw new ApiError(400, "Set a daily budget for the auto router.");
  }
}

/**
 * Each tier's key belongs to the organization, is shared with all of it (every
 * chat, agent and virtual key on the router runs on it) and serves the tier's
 * model.
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
        `The ${tier} tier's key "${key.name}" is not shared with the whole organization. An auto router runs every chat and agent on its tiers' keys.`,
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

/** A router's own decision key is a decisions provider's, shared with the whole organization. */
async function assertValidDecisionKey(
  organizationId: string,
  apiKeyId: string | null,
): Promise<void> {
  if (apiKeyId === null) return;
  const [key, organizationWide] = await Promise.all([
    LlmProviderApiKeyModel.findById(apiKeyId),
    LlmProviderApiKeyModel.findOrganizationWideKeyIds(organizationId),
  ]);
  if (!key || key.organizationId !== organizationId) {
    throw new ApiError(400, "The decision model's key was not found.");
  }
  if (key.provider !== DECISIONS_PROVIDER) {
    throw new ApiError(
      400,
      `The key "${key.name}" is not a decision-model key. Pick a key of a provider that offers decision models.`,
    );
  }
  if (!organizationWide.includes(key.id)) {
    throw new ApiError(
      400,
      `The decision model's key "${key.name}" is not shared with the whole organization.`,
    );
  }
}

/** Runs a fit on `next` that publishes nothing, so a budget the trio cannot meet is never stored. */
async function assertFeasibleBudget(next: AutoRouter): Promise<void> {
  const cheapest = await infeasibleBudget(next);
  if (cheapest === null) return;
  // Rounded up, so the amount shown is itself enough.
  const minimum = (Math.ceil(cheapest * 100) / 100).toFixed(2);
  throw new ApiError(
    400,
    `Budget too low for these models: the cheapest routing costs $${minimum}/day.`,
  );
}

/** What every router of the organization is described with, read once. */
type DescribeContext = {
  agentCounts: Map<string, number>;
  defaultAutoRouterId: string | null;
  virtualApiKeyIds: Map<string, string[]>;
  primaryScorerKey: { id: string; name: string } | null;
};

async function describeContext(
  organizationId: string,
  routers: AutoRouter[],
): Promise<DescribeContext> {
  const [agentCounts, organization, virtualApiKeyIds, primary] =
    await Promise.all([
      AgentModel.countOnAutoRouters(organizationId),
      OrganizationModel.getById(organizationId),
      AutoRouterModel.findVirtualApiKeyIds(routers.map((router) => router.id)),
      LlmProviderApiKeyModel.findOrganizationWideKey(
        organizationId,
        DECISIONS_PROVIDER,
      ),
    ]);
  return {
    agentCounts,
    defaultAutoRouterId: organization?.defaultAutoRouterId ?? null,
    virtualApiKeyIds,
    primaryScorerKey: primary && { id: primary.id, name: primary.name },
  };
}

async function describeOne(
  router: AutoRouter,
  fitted: FitSessions | null = null,
): Promise<AutoRouterResponse> {
  return describe(
    router,
    await describeContext(router.organizationId, [router]),
    fitted,
  );
}

/** `fitted` is the cold-start progress a fit just read, reused when it is for the running scorer version. */
async function describe(
  router: AutoRouter,
  context: DescribeContext,
  fitted: FitSessions | null = null,
): Promise<AutoRouterResponse> {
  const tierIds = TIER_NAMES.map((tier) => router[TIER_FIELDS[tier]]);
  const tierKeyIds = TIER_NAMES.map((tier) => router[TIER_KEY_FIELDS[tier]]);
  const keyIds = [...tierKeyIds, router.scorerApiKeyId].filter(
    (id): id is string => id !== null,
  );
  const [models, keys, active, latest, scorerVersion, scorer] =
    await Promise.all([
      ModelModel.findByIds(tierIds.filter((id): id is string => id !== null)),
      LlmProviderApiKeyModel.findByIds([...new Set(keyIds)]),
      RoutingPlanModel.findActive(router.id),
      RoutingPlanModel.findLatestOutcome(router.id),
      activeSourceVersion(router.scorerModel),
      scorerState(router.organizationId, router.scorerApiKeyId),
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
  const ownScorerKey = keys.find((key) => key.id === router.scorerApiKeyId);
  return {
    id: router.id,
    name: router.name,
    enabled: router.enabled,
    budgetUsdPerDay:
      router.budgetUsdPerDay === null ? null : Number(router.budgetUsdPerDay),
    budgetPreset: router.budgetPreset,
    tiers: { fast, normal, smart },
    decisionModel: {
      apiKeyId: router.scorerApiKeyId,
      model: router.scorerModel,
    },
    usesPastSessions: router.usesPastSessions,
    virtualApiKeyIds: context.virtualApiKeyIds.get(router.id) ?? [],
    usage: {
      agentCount: context.agentCounts.get(router.id) ?? 0,
      organizationDefault: context.defaultAutoRouterId === router.id,
    },
    generation: router.generation,
    plannedGeneration: router.plannedGeneration,
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
                  router,
                  scorerVersionId: scorerVersion.id,
                  inputWatermark: new Date(),
                })
              ).sessions,
        required: config.autoRouting.minSessions,
      },
      lastFitError: latest?.status === "failed" ? latest.error : null,
      scorer,
      scorerApiKey: ownScorerKey
        ? { id: ownScorerKey.id, name: ownScorerKey.name }
        : context.primaryScorerKey,
    },
  };
}
