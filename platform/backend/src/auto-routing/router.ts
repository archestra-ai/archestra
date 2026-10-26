import { randomInt } from "node:crypto";
import { decide } from "@archestra/router-rs";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { ModelModel } from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingScorerVersionModel from "@/models/routing-scorer-version";
import { followAppaSessionHeader } from "@/proxy/plugins/appa-plugin-archestra/host/ingress";
import {
  type ModelRouterAuth,
  type ModelRouterEndpoint,
  ModelRouterEndpointSchema,
} from "@/routes/proxy/model-router-access";
import { setAutoRoutingContext } from "@/routes/proxy/utils/auto-routing-context";
import { extractAutoRoutingSessionMetadata } from "@/routes/proxy/utils/headers/session-metadata";
import { routingPlanCache } from "@/services/routing-plan-cache";
import { ApiError } from "@/types";
import type {
  AutoRoutingSettings,
  InsertRoutingDecision,
  RoutingDecision,
  RoutingDecisionReason,
  RoutingPlan,
  RoutingSessionFeatures,
} from "@/types/auto-routing";
import {
  checkAutoTierEligibility,
  type EligibleTier,
  type IneligibleTier,
  type TierEligibility,
} from "./eligibility";
import { firstUserText } from "./first-user-text";
import { JevScorer } from "./scorer/jev-scorer";
import { specHash } from "./scorer/spec";
import { ScorerError, type SessionScorer } from "./scorer/types";
import {
  fingerprintMatches,
  loadTrio,
  NORMAL_TIER,
  TIER_NAMES,
  type TierIndex,
  type Trio,
} from "./tiers";

export const AUTO_MODEL = "auto";

const FEATURES_SCHEMA_VERSION = 1;
/** router-core crate version, recorded on decisions made without a plan. */
const ROUTER_CORE_VERSION = "0.1.0";

const DecisionSchema = z.object({
  tier_index: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  propensity: z.number(),
});

const sessionScorer: SessionScorer = new JevScorer();

function isAutoModel(model: string): boolean {
  return model.trim() === AUTO_MODEL;
}

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
  endpoint: ModelRouterEndpoint;
  requestedModel: string;
  /** The body as the client sent it. */
  body: unknown;
}): Promise<string> {
  const { request, auth, endpoint, body } = params;
  if (!config.autoRouting.enabled || !isAutoModel(params.requestedModel)) {
    return params.requestedModel;
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
  const text = firstUserText(endpoint, body);
  const sessionKey = RoutingDecisionModel.sessionKey({
    sessionId,
    virtualKeyId: auth.authMethod === "virtual_key" ? auth.virtualKeyId : null,
    firstUserMessage: text,
  });
  const route = (decision: RoutingDecision) =>
    routeByDecision({ request, auth, endpoint, trio, tiers, decision });

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
    return tiers[NORMAL_TIER].routedModel;
  }
  const { decision } = await RoutingDecisionModel.insertOrGet(
    await decideSession({
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
  return route(decision);
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

// === Internal ===

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
    smartModel: { modelId: smart.modelId, provider: smart.provider },
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
      features: RoutingSessionFeatures;
      costUsd: number | null;
      scorerVersionId: string;
    }
  | { kind: "failed"; scorerVersionId: string };

async function decideSession(params: {
  organizationId: string;
  settings: AutoRoutingSettings;
  trio: Trio;
  sessionKey: InsertRoutingDecision["sessionKey"];
  scorerInput: Parameters<SessionScorer["score"]>[0];
}): Promise<InsertRoutingDecision> {
  const { organizationId, trio } = params;
  const scored = await scoreSession(organizationId, params.scorerInput);
  const plan = await routingPlanCache.findActive(organizationId);
  const u = uniform();
  const usable =
    plan !== null && fingerprintMatches(plan.tiersFingerprint, trio);
  if (plan && !usable) await requestReplan(params.settings, organizationId);

  const routed = (
    reason: RoutingDecisionReason,
    tierIndex: TierIndex,
    propensity: number,
    planRow: RoutingPlan | null,
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
    coreVersion: planRow?.coreVersion ?? ROUTER_CORE_VERSION,
    planFormatVersion: planRow?.planFormatVersion ?? null,
  });

  if (plan === null) return routed("cold_start", NORMAL_TIER, 1, null);
  // scorer_error keeps the serving plan as provenance, stale or not.
  if (scored.kind === "failed")
    return routed("scorer_error", NORMAL_TIER, 1, plan);
  if (!usable) return routed("plan_stale", NORMAL_TIER, 1, null);
  const decision = decidePlanned(plan, scored.features, u);
  return decision
    ? routed("planned", decision.tier_index, decision.propensity, plan)
    : routed("plan_stale", NORMAL_TIER, 1, null);
}

function decidePlanned(
  plan: RoutingPlan,
  features: RoutingSessionFeatures,
  u: number,
): z.infer<typeof DecisionSchema> | null {
  try {
    return DecisionSchema.parse(
      JSON.parse(
        decide(JSON.stringify(plan.plan), JSON.stringify(features), u),
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

async function scoreSession(
  organizationId: string,
  input: Parameters<SessionScorer["score"]>[0],
): Promise<Scored> {
  const scorerVersionId = (await activeScorerVersion()).id;
  try {
    const result = await sessionScorer.score(input, {
      organizationId,
      signal: new AbortController().signal,
    });
    return {
      kind: "scored",
      features: {
        tier_needed: result.tierNeeded,
        p_long: result.pLong,
        kind: input.kind,
        source: input.client ?? "unknown",
      },
      costUsd: result.costUsd,
      scorerVersionId,
    };
  } catch (error) {
    if (!(error instanceof ScorerError)) throw error;
    logger.warn(
      { organizationId, reason: error.reason, status: error.status },
      "[AutoRouting] Session scorer failed; routing to the normal tier",
    );
    return { kind: "failed", scorerVersionId };
  }
}

/**
 * The scorer version of the running spec. Upserted by spec hash, so every
 * replica converges on one row; read per new session rather than memoized,
 * as the row is what each decision references.
 */
function activeScorerVersion() {
  const spec = sessionScorer.spec;
  return RoutingScorerVersionModel.upsert({
    name: spec.name,
    model: spec.model,
    spec,
    specHash: specHash(spec),
  });
}

/** Marks the organization dirty once; the dispatcher then fits a plan for the current trio. */
async function requestReplan(
  settings: AutoRoutingSettings,
  organizationId: string,
) {
  if (settings.generation > settings.plannedGeneration) return;
  await AutoRoutingSettingsModel.update(organizationId, {});
}

/** Uniform on [0, 1) from the CSPRNG, at `randomInt`'s full 48-bit range. */
function uniform(): number {
  const range = 2 ** 48 - 1;
  return randomInt(range) / range;
}
