/**
 * Auto routing picks a tier per session from three groups of inputs:
 *
 * - Pre-run signals (`./signals`): per-source readings of the session's
 *   opening, stored in the decision's `features.signals` under the source id
 *   with its version. A plan and its history are tied to the source version
 *   (`scorerVersionId`); a version change cold-starts and fences older fits.
 * - Budget constraints: tier prices, the daily budget and observed volume,
 *   fed to the fit (`./fit`).
 * - Post-run signals: not collected yet. They will land in a
 *   `routing_outcomes(decision_id, source, source_version, kind, value,
 *   observed_at)` table joined to decisions by id; each decision's logged
 *   `propensity` and `u` make those outcomes usable for off-policy estimates.
 *
 * router-core connects them: estimators turn features into per-tier value and
 * expected cost, and the allocator solves λ* and q under the budget. `decide`
 * routes one session with a caller-supplied policy — today the plan's own
 * (`anchorPolicy`), later a pacing controller's λ_t — and records the λ used
 * and the chosen tier's expected cost.
 */
import { randomInt } from "node:crypto";
import { coreVersion, decide } from "@archestra/router-rs";
import { SESSION_ID_HEADER } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { LimitValidationService, ModelModel } from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import type { LimitViolationResponse } from "@/models/limit";
import RoutingDecisionModel from "@/models/routing-decision";
import { followAppaSessionHeader } from "@/proxy/plugins/appa-plugin-archestra/host/ingress";
import {
  type ModelRouterAuth,
  type ModelRouterEndpoint,
  ModelRouterEndpointSchema,
  type ModelRouterLimitAgent,
  modelRouterLimitScope,
} from "@/routes/proxy/model-router-access";
import { setAutoRoutingContext } from "@/routes/proxy/utils/auto-routing-context";
import { extractAutoRoutingSessionMetadata } from "@/routes/proxy/utils/headers/session-metadata";
import { routingPlanCache } from "@/services/routing-plan-cache";
import { ApiError } from "@/types";
import {
  type AutoRoutingSettings,
  FEATURES_SCHEMA_VERSION,
  type InsertRoutingDecision,
  type RoutingDecision,
  type RoutingDecisionFeatures,
  type RoutingDecisionReason,
  type RoutingPlan,
  type RoutingSessionKey,
} from "@/types/auto-routing";
import {
  checkAutoTierEligibility,
  type EligibleTier,
  type IneligibleTier,
  type TierEligibility,
} from "./eligibility";
import { firstUserText } from "./first-user-text";
import {
  activeSourceVersion,
  decisionFeatures,
  preRunSource,
  routerFeatures,
} from "./signals";
import { type PreRunInput, SignalSourceError } from "./signals/types";
import {
  fingerprintMatches,
  loadTrio,
  NORMAL_TIER,
  TIER_NAMES,
  type TierIndex,
  type Trio,
} from "./tiers";

export const AUTO_MODEL = "auto";

const DecisionSchema = z.object({
  tier_index: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  propensity: z.number(),
  lambda: z.number(),
  expected_cost_usd: z.number(),
});
type PlannedDecision = z.infer<typeof DecisionSchema>;

const RouterPolicySchema = z.object({ lam_star: z.number(), q: z.number() });
type RouterPolicy = z.infer<typeof RouterPolicySchema>;

export function isAutoModel(model: string): boolean {
  return model.trim() === AUTO_MODEL;
}

const StoredResponseContinuationSchema = z.object({
  previous_response_id: z.string().min(1),
});

type AutoModelResolution =
  /** Not an "auto" request, or auto routing is off: the model as named. */
  | { kind: "as_requested"; model: string }
  | { kind: "routed"; model: string }
  /** The caller is over a usage limit; nothing was scored. */
  | { kind: "usage_limited"; violation: LimitViolationResponse };

/**
 * The model a Model Router request should be resolved as. Anything but
 * "auto" — and "auto" itself while the feature is off — is returned as is.
 * For "auto", picks the session's sticky tier (deciding it on first sight),
 * records the decision on `request` for the interaction write, and returns
 * the tier's provider-qualified id.
 */
export async function resolveAutoModel(params: {
  request: FastifyRequest;
  auth: ModelRouterAuth;
  agent: ModelRouterLimitAgent;
  endpoint: ModelRouterEndpoint;
  requestedModel: string;
  /** The body as the client sent it. */
  body: unknown;
}): Promise<AutoModelResolution> {
  const { request, auth, endpoint, body } = params;
  if (!config.autoRouting.enabled || !isAutoModel(params.requestedModel)) {
    return { kind: "as_requested", model: params.requestedModel };
  }
  const { settings, trio } = await loadEnabledTrio(auth.organizationId);
  const tiers = requireEligible(await checkTrio({ auth, endpoint, trio }));

  const metadata = extractAutoRoutingSessionMetadata({
    headers: request.headers,
    body,
  });
  const { sessionId } = followAppaSessionHeader({
    headers: request.headers,
    source: "model_router",
    ordinarySession: metadata,
  });
  // Without a session id the tier is keyed on the opening text, which a
  // continuation may not carry: it could land on a provider that does not
  // hold the response it continues.
  if (
    !sessionId &&
    endpoint === "responses" &&
    StoredResponseContinuationSchema.safeParse(body).success
  ) {
    throw new ApiError(
      400,
      `"${AUTO_MODEL}" cannot continue previous_response_id without a session id. Send the same ${SESSION_ID_HEADER} header on every turn of an auto conversation.`,
    );
  }
  const text = firstUserText(endpoint, body);
  const sessionKey = RoutingDecisionModel.sessionKey({
    sessionId,
    virtualKeyId: auth.authMethod === "virtual_key" ? auth.virtualKeyId : null,
    firstUserMessage: text,
  });
  const route = async (
    decision: RoutingDecision,
  ): Promise<AutoModelResolution> => ({
    kind: "routed",
    model: await routeByDecision({
      request,
      auth,
      endpoint,
      trio,
      tiers,
      decision,
      derivedSessionKey: sessionId ? null : sessionKey,
    }),
  });

  const existing = sessionKey
    ? await RoutingDecisionModel.find({
        organizationId: auth.organizationId,
        sessionKey,
      })
    : null;
  if (existing) return route(existing);
  if (!sessionKey || text === null) {
    logger.info(
      {
        organizationId: auth.organizationId,
        reason: sessionKey ? "no_user_text" : "no_session_key",
      },
      "[AutoRouting] Nothing to decide on; routing to the normal tier",
    );
    return { kind: "routed", model: tiers[NORMAL_TIER].routedModel };
  }
  const violation = await LimitValidationService.checkLimitsBeforeRequest(
    modelRouterLimitScope(auth, params.agent),
  );
  if (violation) return { kind: "usage_limited", violation };
  return route(
    await createDecisionOnce({
      organizationId: auth.organizationId,
      settings,
      trio,
      sessionKey,
      scorerInput: {
        firstUserText: text,
        kind: metadata.kind,
        client: metadata.client,
      },
    }),
  );
}

/**
 * Whether "auto" is offered to `auth`: the feature is on, the organization
 * enabled it, and every tier passes the inference-time checks on at least one
 * endpoint they all share.
 */
export async function autoModelAvailable(
  auth: ModelRouterAuth,
): Promise<boolean> {
  if (!config.autoRouting.enabled) return false;
  const settings = await AutoRoutingSettingsModel.find(auth.organizationId);
  if (!settings?.enabled) return false;
  const loaded = await loadTrio(settings);
  if (loaded.kind !== "ok") return false;
  for (const endpoint of ModelRouterEndpointSchema.options) {
    const eligibility = await checkTrio({ auth, endpoint, trio: loaded.trio });
    if (eligibility.every((tier) => tier.eligible)) return true;
  }
  return false;
}

/** Native provider routes cannot serve "auto"; only the Model Router translates between tiers. */
export function assertNotAutoOnNativeRoute(model: string): void {
  if (config.autoRouting.enabled && isAutoModel(model)) {
    throw new ApiError(
      400,
      `"${AUTO_MODEL}" is only available through the Model Router.`,
    );
  }
}

/** The tier a scored session gets from the active plan; null `plan` unless planned. */
type TierSelection = {
  reason: Exclude<RoutingDecisionReason, "scorer_error">;
  tier: TierIndex;
  propensity: number;
  plan: RoutingPlan | null;
  decision: PlannedDecision | null;
  /** The plan cannot route this trio or these features: it needs a re-fit. */
  replan: boolean;
};

/**
 * The plan-selection policy shared by serving and preview, without side
 * effects: a plan of another scorer version cold-starts; one fitted for
 * another trio, or that cannot route `features`, falls back as stale.
 */
export function selectTier(params: {
  active: RoutingPlan | null;
  scorerVersionId: string;
  trio: Trio;
  features: RoutingDecisionFeatures;
  u: number;
}): TierSelection {
  const fallback = (reason: TierSelection["reason"], replan: boolean) => ({
    reason,
    tier: NORMAL_TIER,
    propensity: 1,
    plan: null,
    decision: null,
    replan,
  });
  const plan = servingPlan(params.active, params.scorerVersionId);
  if (plan === null) return fallback("cold_start", false);
  if (!fingerprintMatches(plan.tiersFingerprint, params.trio))
    return fallback("plan_stale", true);
  const decision = decidePlanned(plan, params.features, params.u);
  if (decision === null) return fallback("plan_stale", true);
  return {
    reason: "planned",
    tier: decision.tier_index,
    propensity: decision.propensity,
    plan,
    decision,
    replan: false,
  };
}

/** Uniform on [0, 1) from the CSPRNG, at `randomInt`'s full 48-bit range. */
export function uniform(): number {
  const range = 2 ** 48 - 1;
  return randomInt(range) / range;
}

// === Internal ===

/** A plan fitted on another scorer's features cannot read these. */
function servingPlan(
  active: RoutingPlan | null,
  scorerVersionId: string,
): RoutingPlan | null {
  return active?.scorerVersionId === scorerVersionId ? active : null;
}

/**
 * `decide` against `plan` with the plan's own policy; null when the plan
 * cannot route these features.
 */
function decidePlanned(
  plan: RoutingPlan,
  features: RoutingDecisionFeatures,
  u: number,
): PlannedDecision | null {
  try {
    return DecisionSchema.parse(
      JSON.parse(
        decide(
          JSON.stringify(plan.plan),
          JSON.stringify(anchorPolicy(plan)),
          JSON.stringify(routerFeatures(features)),
          u,
        ),
      ),
    );
  } catch (error) {
    logger.error(
      { err: error, organizationId: plan.organizationId, planId: plan.id },
      "[AutoRouting] Serving plan cannot route; falling back to the normal tier",
    );
    return null;
  }
}

/** The plan's LP optimum (λ*, q): the policy sessions route with until online pacing supplies λ_t. */
function anchorPolicy(plan: RoutingPlan): RouterPolicy {
  return RouterPolicySchema.parse(plan.plan?.policy);
}

async function loadEnabledTrio(
  organizationId: string,
): Promise<{ settings: AutoRoutingSettings; trio: Trio }> {
  const settings = await AutoRoutingSettingsModel.find(organizationId);
  if (!settings?.enabled) {
    throw new ApiError(
      400,
      `Auto routing is not enabled for this organization. Pick a provider-qualified model instead of "${AUTO_MODEL}".`,
    );
  }
  const loaded = await loadTrio(settings);
  if (loaded.kind === "missing") {
    throw new ApiError(
      400,
      `Auto routing has no ${loaded.tier} tier model configured. Configure all three tiers in the auto routing settings.`,
    );
  }
  return { settings, trio: loaded.trio };
}

function checkTrio(params: {
  auth: ModelRouterAuth;
  endpoint: ModelRouterEndpoint;
  trio: Trio;
}): Promise<TierEligibility[]> {
  return Promise.all(
    params.trio.map((model) =>
      checkAutoTierEligibility({
        auth: params.auth,
        endpoint: params.endpoint,
        model,
      }),
    ),
  );
}

/** Re-checks a decision's model unless it is one of the tiers checked for this request. */
async function routeByDecision(params: {
  request: FastifyRequest;
  auth: ModelRouterAuth;
  endpoint: ModelRouterEndpoint;
  trio: Trio;
  tiers: readonly [EligibleTier, EligibleTier, EligibleTier];
  decision: RoutingDecision;
  derivedSessionKey: RoutingSessionKey | null;
}): Promise<string> {
  const { decision, trio } = params;
  const tier = trio.findIndex((model) => model.id === decision.modelId);
  const eligibility =
    tier === -1 ? await checkDecisionModel(params) : params.tiers[tier];
  if (!eligibility.eligible) {
    throw tierUnavailable(TIER_NAMES[decision.tierIndex], eligibility);
  }
  const smart = trio[2];
  setAutoRoutingContext(params.request, {
    decisionId: decision.id,
    smartModel: {
      modelId: smart.modelId,
      provider: smart.provider,
      providerApiKeyId: params.tiers[2].providerApiKeyId,
    },
    derivedSessionKey: params.derivedSessionKey,
  });
  return eligibility.routedModel;
}

async function checkDecisionModel(params: {
  auth: ModelRouterAuth;
  endpoint: ModelRouterEndpoint;
  decision: RoutingDecision;
}): Promise<TierEligibility> {
  const model = await ModelModel.findById(params.decision.modelId);
  if (!model) {
    // The decision's model is gone; the FK cascade removes the decision too.
    throw new ApiError(
      400,
      "The model this session was routed to no longer exists.",
    );
  }
  return checkAutoTierEligibility({
    auth: params.auth,
    endpoint: params.endpoint,
    model,
  });
}

function requireEligible([fast, normal, smart]: TierEligibility[]): readonly [
  EligibleTier,
  EligibleTier,
  EligibleTier,
] {
  if (!fast.eligible) throw tierUnavailable("fast", fast);
  if (!normal.eligible) throw tierUnavailable("normal", normal);
  if (!smart.eligible) throw tierUnavailable("smart", smart);
  return [fast, normal, smart];
}

function tierUnavailable(tier: string, eligibility: IneligibleTier) {
  return new ApiError(
    400,
    `Auto routing ${tier} tier "${eligibility.routedModel}" is not available to this credential: ${eligibility.reason}`,
  );
}

type Scored =
  | {
      kind: "scored";
      features: RoutingDecisionFeatures;
      costUsd: number | null;
      scorerVersionId: string;
    }
  | { kind: "failed"; scorerVersionId: string };

type DecisionParams = {
  organizationId: string;
  settings: AutoRoutingSettings;
  trio: Trio;
  sessionKey: RoutingSessionKey;
  scorerInput: PreRunInput;
};

/** First-request decisions in flight in this process, by organization and session key. */
const decisionsInFlight = new Map<string, Promise<RoutingDecision>>();

/**
 * The session's decision, created at most once per process at a time:
 * concurrent first requests share one scorer call. `insertOrGet` still
 * settles races between processes.
 */
function createDecisionOnce(params: DecisionParams): Promise<RoutingDecision> {
  const key = `${params.organizationId}\u0000${params.sessionKey}`;
  const pending = decisionsInFlight.get(key);
  if (pending) return pending;
  const created = (async () => {
    const stored = await RoutingDecisionModel.find({
      organizationId: params.organizationId,
      sessionKey: params.sessionKey,
    });
    if (stored) return stored;
    const { decision } = await RoutingDecisionModel.insertOrGet(
      await decideSession(params),
    );
    return decision;
  })().finally(() => decisionsInFlight.delete(key));
  decisionsInFlight.set(key, created);
  return created;
}

async function decideSession(
  params: DecisionParams,
): Promise<InsertRoutingDecision> {
  const { organizationId, trio } = params;
  const scored = await scoreSession(organizationId, params.scorerInput);
  if (params.settings.scorerVersionId !== scored.scorerVersionId) {
    await AutoRoutingSettingsModel.activateScorerVersion(
      organizationId,
      scored.scorerVersionId,
    );
  }
  const active = await routingPlanCache.findActive(organizationId);
  const u = uniform();

  const routed = (
    reason: RoutingDecisionReason,
    tierIndex: TierIndex,
    propensity: number,
    planRow: RoutingPlan | null,
    planned: PlannedDecision | null = null,
  ): InsertRoutingDecision => ({
    organizationId,
    sessionKey: params.sessionKey,
    tierIndex,
    modelId: trio[tierIndex].id,
    propensity,
    u,
    planId: planRow?.id ?? null,
    reason,
    scorerVersionId: scored.scorerVersionId,
    features: scored.kind === "scored" ? scored.features : null,
    scorerCost:
      scored.kind === "scored" && scored.costUsd !== null
        ? scored.costUsd.toFixed(10)
        : null,
    featuresSchemaVersion: FEATURES_SCHEMA_VERSION,
    coreVersion: planRow?.coreVersion ?? coreVersion(),
    planFormatVersion: planRow?.planFormatVersion ?? null,
    lambda: planned?.lambda ?? null,
    expectedCostUsd: planned?.expected_cost_usd.toFixed(10) ?? null,
  });

  if (scored.kind === "failed") {
    const plan = servingPlan(active, scored.scorerVersionId);
    if (plan === null) return routed("cold_start", NORMAL_TIER, 1, null);
    if (!fingerprintMatches(plan.tiersFingerprint, trio))
      await requestReplan(params.settings, organizationId);
    // scorer_error keeps the serving plan as provenance, stale or not.
    return routed("scorer_error", NORMAL_TIER, 1, plan);
  }
  const selection = selectTier({
    active,
    scorerVersionId: scored.scorerVersionId,
    trio,
    features: scored.features,
    u,
  });
  if (selection.replan) await requestReplan(params.settings, organizationId);
  return routed(
    selection.reason,
    selection.tier,
    selection.propensity,
    selection.plan,
    selection.decision,
  );
}

async function scoreSession(
  organizationId: string,
  input: PreRunInput,
): Promise<Scored> {
  const scorerVersionId = (await activeSourceVersion()).id;
  try {
    const reading = await preRunSource.read(input, { organizationId });
    return {
      kind: "scored",
      features: decisionFeatures({ version: scorerVersionId, reading, input }),
      costUsd: reading.costUsd,
      scorerVersionId,
    };
  } catch (error) {
    if (!(error instanceof SignalSourceError)) throw error;
    logger.warn(
      { organizationId, reason: error.reason, status: error.status },
      "[AutoRouting] Session scorer failed; routing to the normal tier",
    );
    return { kind: "failed", scorerVersionId };
  }
}

/** Marks the organization dirty once; the dispatcher then fits a plan for the current trio. */
async function requestReplan(
  settings: AutoRoutingSettings,
  organizationId: string,
) {
  if (settings.generation > settings.plannedGeneration) return;
  await AutoRoutingSettingsModel.update(organizationId, {});
}
