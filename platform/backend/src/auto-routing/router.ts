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
import {
  LimitValidationService,
  LlmProviderApiKeyModel,
  ModelModel,
} from "@/models";
import AutoRouterModel from "@/models/auto-router";
import type { LimitViolationResponse } from "@/models/limit";
import RoutingDecisionModel from "@/models/routing-decision";
import { followAppaSessionHeader } from "@/proxy/plugins/appa-plugin-archestra/host/ingress";
import {
  type ModelRouterAuth,
  type ModelRouterEndpoint,
  ModelRouterEndpointSchema,
  type ModelRouterLimitAgent,
  modelRequiresResponses,
  modelRouterLimitScope,
  withRequestSecretsOf,
} from "@/routes/proxy/model-router-access";
import { setAutoRoutingContext } from "@/routes/proxy/utils/auto-routing-context";
import { extractAutoRoutingSessionMetadata } from "@/routes/proxy/utils/headers/session-metadata";
import { routingPlanCache } from "@/services/routing-plan-cache";
import { ApiError, type Model } from "@/types";
import {
  type AutoRouter,
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
  userModelRouterAuth,
} from "./eligibility";
import { firstUserText } from "./first-user-text";
import { scoringContext, scoringContextFingerprint } from "./scoring-context";
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
const AUTO_ROUTER_NAME_PREFIX = `${AUTO_MODEL}:`;

const DecisionSchema = z.object({
  tier_index: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  propensity: z.number(),
  lambda: z.number(),
  expected_cost_usd: z.number(),
});
type PlannedDecision = z.infer<typeof DecisionSchema>;

const RouterPolicySchema = z.object({ lam_star: z.number(), q: z.number() });
type RouterPolicy = z.infer<typeof RouterPolicySchema>;

/** An auto router's name: `auto`, or `auto:<name>` for any other router. */
export function isAutoModel(model: string): boolean {
  const name = model.trim();
  return name === AUTO_MODEL || name.startsWith(AUTO_ROUTER_NAME_PREFIX);
}

const StoredResponseContinuationSchema = z.object({
  previous_response_id: z.string().min(1),
});

type AutoModelResolution =
  /** Not an auto router's name, or auto routing is off: the model as named. */
  | { kind: "as_requested"; model: string }
  /** `auth` is the caller's with the tier's own key first, for a caller the router was added to. */
  | { kind: "routed"; model: string; auth: ModelRouterAuth }
  /** The caller is over a usage limit; nothing was scored. */
  | { kind: "usage_limited"; violation: LimitViolationResponse };

/**
 * The model a Unified Model API request should be resolved as. Anything but
 * an auto router's name — and those while the feature is off — is returned as
 * is. For a router the caller may use, picks the session's sticky tier
 * (deciding it on first sight), records the decision on `request` for the
 * interaction write, and returns the tier's provider-qualified id.
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
  const { settings, trio } = await loadEnabledTrio(
    auth.organizationId,
    params.requestedModel.trim(),
  );
  const routerAuth = await authOnRouter(auth, settings);
  if (!routerAuth) {
    throw new ApiError(
      403,
      `Auto router "${settings.name}" is not added to this virtual key. Add it to the key on the LLM Proxy page.`,
    );
  }
  const tierKeyIds = tierApiKeyIds(settings);
  const tiers = requireEligible(
    await checkTrio({
      auth: routerAuth,
      endpoint,
      trio,
      preferredTierKeyIds: routerAuth === auth ? undefined : tierKeyIds,
    }),
  );
  const onTier = (tier: EligibleTier): ModelRouterAuth =>
    routerAuth === auth
      ? auth
      : preferringKey(routerAuth, tier.providerApiKeyId);

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
      `"${settings.name}" cannot continue previous_response_id without a session id. Send the same ${SESSION_ID_HEADER} header on every turn of an auto conversation.`,
    );
  }
  const text = firstUserText(endpoint, body);
  const sessionKey = RoutingDecisionModel.sessionKey({
    sessionId,
    virtualKeyId: auth.authMethod === "virtual_key" ? auth.virtualKeyId : null,
    firstUserMessage: text,
    contextFingerprint: sessionId
      ? undefined
      : scoringContextFingerprint(scoringContext(body, { openingOnly: true })),
  });
  const decided = await sessionDecision({
    settings,
    trio,
    sessionKey,
    text,
    client: metadata.client,
    body,
    beforeScoring: async () =>
      LimitValidationService.checkLimitsBeforeRequest({
        ...modelRouterLimitScope(auth, params.agent),
        deferModelScopedLimits: true,
      }),
  });
  switch (decided.kind) {
    case "usage_limited":
      return decided;
    case "undecided":
      return {
        kind: "routed",
        model: tiers[NORMAL_TIER].routedModel,
        auth: onTier(tiers[NORMAL_TIER]),
      };
    case "decided": {
      const routed = await routeByDecision({
        request,
        auth: routerAuth,
        endpoint,
        trio,
        tiers,
        decision: decided.decision,
        derivedSessionKey: sessionId ? null : sessionKey,
      });
      return {
        kind: "routed",
        model: routed.tier.routedModel,
        auth: onTier(routed.tier),
      };
    }
  }
}

/** The tier model an auto-routed platform call runs on, with the key it is sent with. */
type InternalAutoRoute = { model: Model; providerApiKeyId: string };

/**
 * Routes a platform call on the auto router `routerId` on a native provider route: the session's
 * sticky tier, decided on first sight as for the Unified Model API, on the
 * tier's key (else one `userId` may use for it). The caller already checked
 * usage limits. Records the decision on `request` for the interaction write.
 *
 * Null when the call is not routed: auto routing is off, the router is gone, a tier is out of the
 * user's reach, or `reachable` says the client's wire cannot get to a tier's
 * provider. The call then runs on the model it names (the normal tier), and no
 * decision is stored that a later call could not follow.
 */
export async function routeInternalAutoSession(params: {
  request: FastifyRequest;
  organizationId: string;
  routerId: string;
  userId: string;
  /** The key the call names; a tier it serves is sent on it, not the user's ranked key. */
  callApiKeyId: string | null;
  sessionId: string | null;
  /** The body as the platform sent it, in OpenAI or Anthropic message shapes. */
  body: unknown;
  reachable: (provider: Model["provider"]) => boolean;
}): Promise<InternalAutoRoute | null> {
  const { request, organizationId } = params;
  const unroutable = (reason: string) => {
    logger.warn(
      { organizationId, routerId: params.routerId, reason },
      "[AutoRouting] Call runs on the model it names",
    );
    return null;
  };
  const settings = await AutoRouterModel.findInOrganization(
    organizationId,
    params.routerId,
  );
  if (!settings?.enabled) return null;
  const loaded = await loadTrio(settings);
  if (loaded.kind === "missing") {
    return unroutable(`no ${loaded.tier} tier model is configured`);
  }
  const { trio } = loaded;
  const unreachable = trio.find((model) => !params.reachable(model.provider));
  if (unreachable) {
    return unroutable(
      `the client's wire cannot reach the "${unreachable.provider}/${unreachable.modelId}" tier`,
    );
  }
  const chatless = trio.find(responsesOnly);
  if (chatless) {
    return unroutable(
      `the "${chatless.provider}/${chatless.modelId}" tier is served only on the Responses API`,
    );
  }
  const auth = await userModelRouterAuth({
    organizationId,
    userId: params.userId,
    preferredApiKeyIds: [...tierApiKeyIds(settings), params.callApiKeyId],
  });
  const eligibility = await checkTrio({
    auth,
    endpoint: null,
    trio,
    preferredTierKeyIds: tierApiKeyIds(settings),
  });
  const ineligible = eligibility.find((tier) => !tier.eligible);
  if (ineligible && !ineligible.eligible) {
    return unroutable(
      `tier "${ineligible.routedModel}" is not available to the user: ${ineligible.reason}`,
    );
  }
  const tiers = requireEligible(eligibility);
  const text = firstUserText("chat_completions", params.body);
  const sessionKey = RoutingDecisionModel.sessionKey({
    sessionId: params.sessionId,
    virtualKeyId: null,
    firstUserMessage: text,
  });
  const decided = await sessionDecision({
    settings,
    trio,
    sessionKey,
    text,
    client: null,
    body: params.body,
    beforeScoring: async () => null,
  });
  const onNormal = {
    model: trio[NORMAL_TIER],
    providerApiKeyId: tiers[NORMAL_TIER].providerApiKeyId,
  };
  if (decided.kind !== "decided") return onNormal;
  const { decision } = decided;
  const target = await decisionTarget({
    auth,
    endpoint: null,
    trio,
    tiers,
    decision,
  });
  // A stored decision may name a model that has since left the trio; a call
  // that cannot follow it runs on normal rather than failing.
  const unfollowable =
    target.kind === "unavailable"
      ? target.error.message
      : !params.reachable(target.model.provider)
        ? "the client's wire cannot reach its provider"
        : responsesOnly(target.model)
          ? "it is served only on the Responses API"
          : null;
  if (unfollowable !== null || target.kind === "unavailable") {
    logger.warn(
      { organizationId, decisionId: decision.id, reason: unfollowable },
      "[AutoRouting] The session's routed model cannot serve this call; it runs on the normal tier",
    );
    return onNormal;
  }
  attachDecision({
    request,
    trio,
    tiers,
    decision,
    derivedSessionKey: params.sessionId ? null : sessionKey,
  });
  return {
    model: target.model,
    providerApiKeyId: target.tier.providerApiKeyId,
  };
}

/**
 * The names of the auto routers offered to `auth`: the feature is on, the
 * organization enabled it, the caller may use the router, and every tier
 * passes the inference-time checks on at least one endpoint they all share.
 */
export async function availableAutoRouterNames(
  auth: ModelRouterAuth,
): Promise<string[]> {
  if (!config.autoRouting.enabled) return [];
  const routers = await AutoRouterModel.list(auth.organizationId);
  const names: string[] = [];
  for (const settings of routers) {
    if (!settings.enabled) return [];
    const loaded = await loadTrio(settings);
    if (loaded.kind !== "ok") continue;
    const routerAuth = await authOnRouter(auth, settings);
    if (!routerAuth) continue;
    for (const endpoint of ModelRouterEndpointSchema.options) {
      const eligibility = await checkTrio({
        auth: routerAuth,
        endpoint,
        trio: loaded.trio,
        preferredTierKeyIds:
          routerAuth === auth ? undefined : tierApiKeyIds(settings),
      });
      if (eligibility.every((tier) => tier.eligible)) {
        names.push(settings.name);
        break;
      }
    }
  }
  return names;
}

/** Native provider routes cannot serve an auto router; only the Unified Model API translates between tiers. */
export function assertNotAutoOnNativeRoute(model: string): void {
  if (config.autoRouting.enabled && isAutoModel(model)) {
    throw new ApiError(
      400,
      `"${model.trim()}" is only available through the Unified Model API.`,
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
  name: string,
): Promise<{ settings: AutoRouter; trio: Trio }> {
  const settings = await AutoRouterModel.findByName(organizationId, name);
  if (!settings) {
    throw new ApiError(
      400,
      `No auto router is named "${name}". Pick one of the organization's auto routers or a provider-qualified model.`,
    );
  }
  if (!settings.enabled) {
    throw new ApiError(
      400,
      `Auto routing is not enabled for this organization. Pick a provider-qualified model instead of "${name}".`,
    );
  }
  const loaded = await loadTrio(settings);
  if (loaded.kind === "missing") {
    throw new ApiError(
      400,
      `Auto router "${name}" has no ${loaded.tier} tier model configured. Set its ${loaded.tier} model.`,
    );
  }
  return { settings, trio: loaded.trio };
}

function tierApiKeyIds(settings: AutoRouter) {
  return [
    settings.fastApiKeyId,
    settings.normalApiKeyId,
    settings.smartApiKeyId,
  ] as const;
}

/**
 * The caller's auth as the router sees it; null when the caller may not use
 * the router. A virtual key may only when the router was added to it, and
 * then spends the tiers' own keys, the way it spends a model pool's member
 * keys, whatever provider keys it maps. Any other caller keeps its own keys
 * and reaches the router when those reach every tier.
 */
async function authOnRouter(
  auth: ModelRouterAuth,
  settings: AutoRouter,
): Promise<ModelRouterAuth | null> {
  if (auth.authMethod !== "virtual_key") return auth;
  if (
    !(await AutoRouterModel.hasVirtualApiKeyGrant(
      settings.id,
      auth.virtualKeyId,
    ))
  ) {
    return null;
  }
  const ids = tierApiKeyIds(settings).filter((id): id is string => id !== null);
  const keys = await LlmProviderApiKeyModel.findByIds([...new Set(ids)]);
  return withRequestSecretsOf(auth, {
    ...auth,
    providerApiKeys: [
      ...keys
        .filter((key) => key.organizationId === auth.organizationId)
        .map((key) => ({
          provider: key.provider,
          providerApiKeyId: key.id,
          providerApiKeyName: key.name,
          secretId: key.secretId,
          baseUrl: key.inferenceBaseUrl ?? key.baseUrl,
          scope: key.scope,
          userId: key.userId,
        })),
      ...auth.providerApiKeys,
    ],
  });
}

/** `auth` with `providerApiKeyId` tried first, so forwarding sends the tier on the key it was checked with. */
function preferringKey(
  auth: ModelRouterAuth,
  providerApiKeyId: string,
): ModelRouterAuth {
  return withRequestSecretsOf(auth, {
    ...auth,
    providerApiKeys: [...auth.providerApiKeys].sort(
      (a, b) =>
        Number(b.providerApiKeyId === providerApiKeyId) -
        Number(a.providerApiKeyId === providerApiKeyId),
    ),
  });
}

/**
 * The session's decision: the stored one, else a new one when there is a
 * session key and opening text to score. `beforeScoring` may refuse a new
 * decision for being over a usage limit.
 */
async function sessionDecision(params: {
  settings: AutoRouter;
  trio: Trio;
  sessionKey: RoutingSessionKey | null;
  text: string | null;
  client: string | null;
  body: unknown;
  beforeScoring: () => Promise<LimitViolationResponse | null>;
}): Promise<
  | { kind: "decided"; decision: RoutingDecision }
  | { kind: "undecided" }
  | { kind: "usage_limited"; violation: LimitViolationResponse }
> {
  const { sessionKey, text } = params;
  const routerId = params.settings.id;
  const existing = sessionKey
    ? await RoutingDecisionModel.find({ routerId, sessionKey })
    : null;
  if (existing) return { kind: "decided", decision: existing };
  if (!sessionKey || text === null) {
    logger.info(
      {
        routerId,
        reason: sessionKey ? "no_user_text" : "no_session_key",
      },
      "[AutoRouting] Nothing to decide on; routing to the normal tier",
    );
    return { kind: "undecided" };
  }
  const violation = await params.beforeScoring();
  if (violation) return { kind: "usage_limited", violation };
  return {
    kind: "decided",
    decision: await createDecisionOnce({
      settings: params.settings,
      trio: params.trio,
      sessionKey,
      scorerInput: {
        firstUserText: text,
        client: params.client,
        ...scoringContext(params.body),
      },
    }),
  };
}

function checkTrio(params: {
  auth: ModelRouterAuth;
  endpoint: ModelRouterEndpoint | null;
  trio: Trio;
  /** Internal Auto calls prefer each tier's configured key, not the first tier's key. */
  preferredTierKeyIds?: readonly (string | null)[];
}): Promise<TierEligibility[]> {
  return Promise.all(
    params.trio.map((model, index) =>
      checkAutoTierEligibility({
        auth: params.preferredTierKeyIds?.[index]
          ? preferringKey(params.auth, params.preferredTierKeyIds[index])
          : params.auth,
        endpoint: params.endpoint,
        model,
      }),
    ),
  );
}

async function routeByDecision(params: {
  request: FastifyRequest;
  auth: ModelRouterAuth;
  endpoint: ModelRouterEndpoint | null;
  trio: Trio;
  tiers: readonly [EligibleTier, EligibleTier, EligibleTier];
  decision: RoutingDecision;
  derivedSessionKey: RoutingSessionKey | null;
}): Promise<{ model: Model; tier: EligibleTier }> {
  const target = await decisionTarget(params);
  if (target.kind === "unavailable") throw target.error;
  attachDecision(params);
  return target;
}

type DecisionTarget =
  | { kind: "eligible"; model: Model; tier: EligibleTier }
  | { kind: "unavailable"; error: ApiError };

/** Re-checks a decision's model unless it is one of the tiers checked for this request. */
async function decisionTarget(params: {
  auth: ModelRouterAuth;
  endpoint: ModelRouterEndpoint | null;
  trio: Trio;
  tiers: readonly [EligibleTier, EligibleTier, EligibleTier];
  decision: RoutingDecision;
}): Promise<DecisionTarget> {
  const { decision, trio } = params;
  const tier = trio.findIndex((model) => model.id === decision.modelId);
  if (tier !== -1) {
    return { kind: "eligible", model: trio[tier], tier: params.tiers[tier] };
  }
  const model = await ModelModel.findById(decision.modelId);
  if (!model) {
    // The decision's model is gone; the FK cascade removes the decision too.
    return {
      kind: "unavailable",
      error: new ApiError(
        400,
        "The model this session was routed to no longer exists.",
      ),
    };
  }
  const eligibility = await checkAutoTierEligibility({
    auth: params.auth,
    endpoint: params.endpoint,
    model,
  });
  return eligibility.eligible
    ? { kind: "eligible", model, tier: eligibility }
    : {
        kind: "unavailable",
        error: tierUnavailable(TIER_NAMES[decision.tierIndex], eligibility),
      };
}

/** Records the decision on `request` for the interaction write. */
function attachDecision(params: {
  request: FastifyRequest;
  trio: Trio;
  tiers: readonly [EligibleTier, EligibleTier, EligibleTier];
  decision: RoutingDecision;
  derivedSessionKey: RoutingSessionKey | null;
}): void {
  const smart = params.trio[2];
  setAutoRoutingContext(params.request, {
    decisionId: params.decision.id,
    smartModel: {
      modelId: smart.modelId,
      provider: smart.provider,
      providerApiKeyId: params.tiers[2].providerApiKeyId,
    },
    derivedSessionKey: params.derivedSessionKey,
  });
}

/** A tier is sent on its provider's chat wire, which a Responses-only model does not serve. */
function responsesOnly(model: Model): boolean {
  return modelRequiresResponses({
    provider: model.provider,
    modelId: model.modelId,
    supportedEndpoints: model.supportedEndpoints ?? null,
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
  settings: AutoRouter;
  trio: Trio;
  sessionKey: RoutingSessionKey;
  scorerInput: PreRunInput;
};

/** First-request decisions in flight in this process, by router and session key. */
const decisionsInFlight = new Map<string, Promise<RoutingDecision>>();

/**
 * The session's decision, created at most once per process at a time:
 * concurrent first requests share one scorer call. `insertOrGet` still
 * settles races between processes.
 */
function createDecisionOnce(params: DecisionParams): Promise<RoutingDecision> {
  const routerId = params.settings.id;
  const key = `${routerId}\u0000${params.sessionKey}`;
  const pending = decisionsInFlight.get(key);
  if (pending) return pending;
  const created = (async () => {
    const stored = await RoutingDecisionModel.find({
      routerId,
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
  const { settings, trio } = params;
  const scored = await scoreSession(settings, params.scorerInput);
  if (settings.scorerVersionId !== scored.scorerVersionId) {
    await AutoRouterModel.activateScorerVersion(
      settings.id,
      scored.scorerVersionId,
    );
  }
  const active = await routingPlanCache.findActive(settings.id);
  const u = uniform();

  const routed = (
    reason: RoutingDecisionReason,
    tierIndex: TierIndex,
    propensity: number,
    planRow: RoutingPlan | null,
    planned: PlannedDecision | null = null,
  ): InsertRoutingDecision => ({
    organizationId: settings.organizationId,
    routerId: settings.id,
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
      await requestReplan(settings);
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
  if (selection.replan) await requestReplan(settings);
  return routed(
    selection.reason,
    selection.tier,
    selection.propensity,
    selection.plan,
    selection.decision,
  );
}

async function scoreSession(
  settings: AutoRouter,
  input: PreRunInput,
): Promise<Scored> {
  const scorerVersionId = (await activeSourceVersion(settings.scorerModel)).id;
  try {
    const reading = await preRunSource(settings.scorerModel).read(input, {
      organizationId: settings.organizationId,
      apiKeyId: settings.scorerApiKeyId,
    });
    return {
      kind: "scored",
      features: decisionFeatures({ version: scorerVersionId, reading, input }),
      costUsd: reading.costUsd,
      scorerVersionId,
    };
  } catch (error) {
    if (!(error instanceof SignalSourceError)) throw error;
    logger.warn(
      { routerId: settings.id, reason: error.reason, status: error.status },
      "[AutoRouting] Session scorer failed; routing to the normal tier",
    );
    return { kind: "failed", scorerVersionId };
  }
}

/** Marks the router dirty once; the dispatcher then fits a plan for the current trio. */
async function requestReplan(settings: AutoRouter) {
  if (settings.generation > settings.plannedGeneration) return;
  await AutoRouterModel.update(settings.id, {});
}
