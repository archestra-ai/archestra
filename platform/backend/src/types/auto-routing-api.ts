import {
  AUTO_ROUTING_BACKFILL_MAX_COST_USD,
  AUTO_ROUTING_BACKFILL_SCORER_CALLS,
  SupportedProvidersSchema,
} from "@archestra/shared";
import { z } from "zod";
import {
  RouterDocumentSchema,
  RoutingBackfillBreakdownSchema,
  RoutingBackfillPhaseSchema,
  RoutingBackfillStatusSchema,
  RoutingDecisionReasonSchema,
  RoutingPlanRecordSchema,
  RoutingPlanStatusSchema,
  RoutingPlanTriggerSchema,
} from "@/types/auto-routing";

/** `routing_plans.budget_usd_per_day` is numeric(12, 2). */
const BudgetUsdPerDaySchema = z.number().min(0.01).max(9_999_999_999.99);

export const AutoRoutingTierNameSchema = z.enum(["fast", "normal", "smart"]);

const AutoRoutingTierModelSchema = z.object({
  id: z.string().uuid(),
  provider: SupportedProvidersSchema,
  modelId: z.string(),
});

/** Whether the session scorer can score sessions, live or past, or why not. */
export const AutoRoutingScorerStateSchema = z.enum(["ready", "no_jev_key"]);
export type AutoRoutingScorerState = z.infer<
  typeof AutoRoutingScorerStateSchema
>;

export const AutoRoutingSettingsResponseSchema = z.object({
  enabled: z.boolean(),
  budgetUsdPerDay: z.number().nullable(),
  tiers: z.object({
    fast: AutoRoutingTierModelSchema.nullable(),
    normal: AutoRoutingTierModelSchema.nullable(),
    smart: AutoRoutingTierModelSchema.nullable(),
  }),
  /** Agents on the organization default, which routing applies to. */
  routedAgentCount: z.number().int().nonnegative(),
  generation: z.number().int(),
  plannedGeneration: z.number().int(),
  status: z.object({
    activePlan: z
      .object({ id: z.string().uuid(), createdAt: z.date() })
      .nullable(),
    /** Sessions a fit started now would read (scored by the running scorer version, idle for a day), against the fit's minimum. */
    coldStart: z.object({
      scorerVersionId: z.string().uuid(),
      sessions: z.number().int().nonnegative(),
      required: z.number().int().positive(),
    }),
    /** Error of the newest fit outcome, when it failed. */
    lastFitError: z.string().nullable(),
    scorer: AutoRoutingScorerStateSchema,
  }),
});
export type AutoRoutingSettingsResponse = z.infer<
  typeof AutoRoutingSettingsResponseSchema
>;

/**
 * Outcome of the fit a settings change or re-plan ran; a fit that lost to a
 * concurrent one reports the winner's. `unchanged`: a re-plan found nothing
 * new since the active plan, so it ran no fit.
 */
export const AutoRoutingFitResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active"), planId: z.string().uuid() }),
  z.object({ status: z.literal("unchanged"), planId: z.string().uuid() }),
  z.object({
    status: z.literal("cold_start"),
    planId: z.string().uuid().nullable(),
  }),
  z.object({
    status: z.literal("failed"),
    planId: z.string().uuid().nullable(),
    error: z.string(),
  }),
]);
export type AutoRoutingFitResult = z.infer<typeof AutoRoutingFitResultSchema>;

/** `fit` is null when no fit ran: auto routing is disabled or not fully configured. */
export const AutoRoutingSettingsChangeResponseSchema =
  AutoRoutingSettingsResponseSchema.extend({
    fit: AutoRoutingFitResultSchema.nullable(),
  });
export type AutoRoutingSettingsChangeResponse = z.infer<
  typeof AutoRoutingSettingsChangeResponseSchema
>;

export const UpdateAutoRoutingSettingsBodySchema = z.strictObject({
  enabled: z.boolean().optional(),
  budgetUsdPerDay: BudgetUsdPerDaySchema.optional(),
});
export type UpdateAutoRoutingSettingsBody = z.infer<
  typeof UpdateAutoRoutingSettingsBodySchema
>;

export const AutoRoutingPlanSummarySchema = z.object({
  id: z.string().uuid(),
  createdAt: z.date(),
  trigger: RoutingPlanTriggerSchema,
  status: RoutingPlanStatusSchema,
  generation: z.number().int(),
  inputWatermark: z.date(),
  budgetUsdPerDay: z.number(),
  scorerVersion: RoutingPlanRecordSchema.shape.scorerVersion,
  coreVersion: z.string(),
  planFormatVersion: z.number().int(),
  summary: RouterDocumentSchema.nullable(),
  diagnostics: RouterDocumentSchema.nullable(),
  error: z.string().nullable(),
  /** Sessions this plan routed. */
  decisionCount: z.number().int().nonnegative(),
});

export type AutoRoutingPlanSummary = z.infer<
  typeof AutoRoutingPlanSummarySchema
>;

/** Adds the router-core plan document (size and long-share coefficients, policy) and the tiers it was fitted for. */
export const AutoRoutingPlanDetailSchema = AutoRoutingPlanSummarySchema.extend({
  tiersFingerprint: RouterDocumentSchema,
  plan: RouterDocumentSchema.nullable(),
});
export type AutoRoutingPlanDetail = z.infer<typeof AutoRoutingPlanDetailSchema>;

export const AutoRoutingPlansQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * The scorer clips the text to its head and tail before asking, so longer
 * input changes nothing but the omitted-length note; this bounds the body
 * while still accepting a long pasted first message.
 */
export const AUTO_ROUTING_PREVIEW_MAX_CHARS = 20_000;

export const AutoRoutingPreviewBodySchema = z.strictObject({
  text: z.string().trim().min(1).max(AUTO_ROUTING_PREVIEW_MAX_CHARS),
});

export const AutoRoutingSimulateBodySchema = z.strictObject({
  budgetUsdPerDay: BudgetUsdPerDaySchema,
  /** Scales the fitted window's sessions/day and tokens/day alike. */
  volumeMultiplier: z.number().positive().max(100),
});

/** The fitted usage window's arrival rate, before the simulated multiplier. */
const SimulatedTrafficSchema = z.object({
  sessionsPerDay: z.number().nonnegative(),
  tokensPerDay: z.number().nonnegative(),
});
export type SimulatedTraffic = z.infer<typeof SimulatedTrafficSchema>;

/**
 * A fit at the given budget and scaled volume that publishes nothing.
 * `summary` is router-core's plan summary and `tiersFingerprint` the tiers it
 * was fitted for, as a plan's; `infeasible` gives the cheapest routing's
 * USD/day, rounded up to the cent.
 */
export const AutoRoutingSimulateResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("feasible"),
      summary: RouterDocumentSchema,
      tiersFingerprint: RouterDocumentSchema,
      baseline: SimulatedTrafficSchema,
    }),
    z.object({
      status: z.literal("infeasible"),
      minBudgetUsdPerDay: z.number(),
      baseline: SimulatedTrafficSchema,
    }),
    z.object({
      status: z.literal("cold_start"),
      sessions: z.number().int().nonnegative(),
      required: z.number().int().positive(),
    }),
  ],
);
export type AutoRoutingSimulateResponse = z.infer<
  typeof AutoRoutingSimulateResponseSchema
>;

export const AutoRoutingDiagnosticsQuerySchema = z.object({
  /** Defaults to the active plan's budget. */
  budgetUsdPerDay: z.coerce.number().min(0.01).max(9_999_999_999.99).optional(),
});

const TierTripleSchema = z.tuple([z.number(), z.number(), z.number()]);

/**
 * How the size model predicts sessions it was not fitted on: none without a
 * holdout (a client with too few sessions), nor when that fit failed.
 * `plotted` and `excluded` count the displayed held-out sessions with and
 * without a positive predicted and realized size.
 */
const AutoRoutingSizeFitSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    testSessions: z.number().int().nonnegative(),
    plotted: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    spearman: z.number().nullable(),
    medianRealizedOverPredicted: z.number().nullable(),
  }),
  z.object({ status: z.literal("no_holdout") }),
  z.object({ status: z.literal("failed") }),
]);
export type AutoRoutingSizeFit = z.infer<typeof AutoRoutingSizeFitSchema>;

/**
 * The current fit history re-solved at `budgetUsdPerDay` without publishing.
 * Each displayed session carries its Jev reading, realized tokens, the size
 * predicted by a fit on each client's earliest 70% of sessions (null for
 * those training sessions), its per-token tier prices and the tier the
 * re-solved policy routes it to (a tie drawn with probability q).
 */
export const AutoRoutingDiagnosticsResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("ready"),
      budgetUsdPerDay: z.number(),
      savedBudgetUsdPerDay: z.number(),
      lamStar: z.number(),
      q: z.number(),
      /** Over the whole history, not only the displayed sessions. */
      tierSessionShare: TierTripleSchema,
      sizeFit: AutoRoutingSizeFitSchema,
      sessions: z.array(
        z.object({
          tierNeeded: TierTripleSchema,
          pLong: z.number(),
          realizedTokens: z.number(),
          predictedTokens: z.number().nullable(),
          usdPerToken: TierTripleSchema,
          tier: AutoRoutingTierNameSchema,
        }),
      ),
    }),
    z.object({
      status: z.literal("infeasible"),
      budgetUsdPerDay: z.number(),
      savedBudgetUsdPerDay: z.number(),
      minBudgetUsdPerDay: z.number(),
    }),
    z.object({ status: z.literal("cold_start") }),
  ],
);
export type AutoRoutingDiagnostics = z.infer<
  typeof AutoRoutingDiagnosticsResponseSchema
>;

export const AutoRoutingPreviewResponseSchema = z.object({
  tierNeeded: z.tuple([z.number(), z.number(), z.number()]),
  pLong: z.number(),
  reason: RoutingDecisionReasonSchema.exclude(["scorer_error"]),
  planId: z.string().uuid().nullable(),
  chosen: z.object({
    tier: AutoRoutingTierNameSchema,
    model: AutoRoutingTierModelSchema,
  }),
  propensity: z.number(),
  /** The chosen tier's predicted session cost in USD; null unless planned. */
  expectedCostUsd: z.number().nullable(),
  scorerCostUsd: z.number().nullable(),
});
export type AutoRoutingPreviewResponse = z.infer<
  typeof AutoRoutingPreviewResponseSchema
>;

/** Most past sessions one backfill scores. */
export const AUTO_ROUTING_BACKFILL_MAX_SESSIONS = 5000;

/** Starts scoring what `scoreOffer` named; refused with a 409 once it names something else. */
export const AutoRoutingScoreBackfillBodySchema = z.strictObject({
  backfillId: z.string().uuid(),
  scorerVersionId: z.string().uuid(),
  maxSessions: z
    .number()
    .int()
    .min(1)
    .max(AUTO_ROUTING_BACKFILL_MAX_SESSIONS)
    .default(3000),
  maxCostUsd: z
    .number()
    .positive()
    .max(AUTO_ROUTING_BACKFILL_MAX_COST_USD)
    .describe(
      `Spending limit for the scorer calls in USD; may be exceeded by at most ${AUTO_ROUTING_BACKFILL_SCORER_CALLS} × the per-call cost of the calls in flight`,
    ),
});
export type AutoRoutingScoreBackfillBody = z.infer<
  typeof AutoRoutingScoreBackfillBodySchema
>;

export const AutoRoutingBackfillResponseSchema = z.object({
  /** The organization's newest backfill. */
  backfill: z
    .object({
      id: z.string().uuid(),
      status: RoutingBackfillStatusSchema,
      phase: RoutingBackfillPhaseSchema,
      windowStart: z.date(),
      cutoff: z.date(),
      /** Past sessions eligible for history, counted when the scan finished. */
      eligibleSessions: z.number().int().nonnegative(),
      eligibleTokens: z.number().nonnegative(),
      breakdown: RoutingBackfillBreakdownSchema,
      /** Whether it scores with the running scorer version; null before scoring starts. */
      scorerCurrent: z.boolean().nullable(),
      maxSessions: z.number().int().nullable(),
      maxCostUsd: z.number().nullable(),
      spentCostUsd: z.number(),
      progress: z
        .object({
          sample: z.number().int(),
          scored: z.number().int(),
          noText: z.number().int(),
          failed: z.number().int(),
        })
        .nullable(),
      error: z.string().nullable(),
      completedAt: z.date().nullable(),
      /** The fit its completion requested has no outcome yet and will run. */
      awaitingFit: z.boolean(),
      /** Why the fit its completion requested will not run while settings stay as they are. */
      fitBlockedReason: z.string().nullable(),
    })
    .nullable(),
  /** What scoring the latest scan with the running scorer version would take; null when nothing is left to score. */
  scoreOffer: z
    .object({
      /** The scan and scorer version scoring would use; a score request names both. */
      backfillId: z.string().uuid(),
      scorerVersionId: z.string().uuid(),
      /** That scan's window, which scoring reads. */
      windowStart: z.date(),
      cutoff: z.date(),
      sessions: z.number().int().positive(),
      remaining: z.number().int().positive(),
      estimatedCostUsd: z.number(),
      suggestedMaxCostUsd: z.number(),
      /** The sessions were scored before by another scorer version. */
      rescore: z.boolean(),
    })
    .nullable(),
});
export type AutoRoutingBackfillResponse = z.infer<
  typeof AutoRoutingBackfillResponseSchema
>;
