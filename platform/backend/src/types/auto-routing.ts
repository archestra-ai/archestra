import type { SupportedProvider } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const RoutingDecisionReasonSchema = z.enum([
  "planned",
  "cold_start",
  "scorer_error",
  "plan_stale",
]);
export type RoutingDecisionReason = z.infer<typeof RoutingDecisionReasonSchema>;

export const RoutingPlanTriggerSchema = z.enum([
  "initial",
  "nightly",
  "settings",
  "manual",
  "scorer_change",
  "backfill",
]);
export type RoutingPlanTrigger = z.infer<typeof RoutingPlanTriggerSchema>;

export const RoutingPlanStatusSchema = z.enum([
  "active",
  "superseded",
  "failed",
  "cold_start",
  /** Fenced out at publication by newer settings, scorer version or usage. */
  "rejected",
]);
export type RoutingPlanStatus = z.infer<typeof RoutingPlanStatusSchema>;

/** router-core `SessionFeatures`: the core's input, derived from `RoutingDecisionFeatures`. */
export const RoutingSessionFeaturesSchema = z.object({
  tier_needed: z.tuple([z.number(), z.number(), z.number()]),
  p_long: z.number().min(0).max(1),
  source: z.string(),
});
export type RoutingSessionFeatures = z.infer<
  typeof RoutingSessionFeaturesSchema
>;

/** Shape version of `RoutingDecisionFeatures`, recorded on every decision. */
export const FEATURES_SCHEMA_VERSION = 1;

/** The Jev session signal; `version` is the scorer version that produced it. */
export const JevSessionSignalSchema = z.object({
  version: z.string().uuid(),
  tier_needed: z.tuple([z.number(), z.number(), z.number()]),
  p_long: z.number().min(0).max(1),
});

/** A decision's pre-run inputs: signals by source id, plus the request's metadata. */
export const RoutingDecisionFeaturesSchema = z.object({
  signals: z.object({ "jev-session": JevSessionSignalSchema }),
  client: z.string(),
});
export type RoutingDecisionFeatures = z.infer<
  typeof RoutingDecisionFeaturesSchema
>;

/** A router-core JSON document (plan, tiers fingerprint) stored verbatim. */
export const RouterDocumentSchema = z.record(z.string(), z.unknown());
export type RouterDocument = z.infer<typeof RouterDocumentSchema>;

/** Canonical scorer spec: everything that shapes the scorer's answers. */
export const RoutingScorerSpecSchema = z.record(z.string(), z.unknown());
export type RoutingScorerSpec = z.infer<typeof RoutingScorerSpecSchema>;

/** Identity of a sticky routing decision within its organization. */
export const RoutingSessionKeySchema = z
  .string()
  .min(1)
  .brand<"RoutingSessionKey">();
export type RoutingSessionKey = z.infer<typeof RoutingSessionKeySchema>;

export const SelectRoutingScorerVersionSchema = createSelectSchema(
  schema.routingScorerVersionsTable,
  { spec: RoutingScorerSpecSchema },
);
export type RoutingScorerVersion = z.infer<
  typeof SelectRoutingScorerVersionSchema
>;

export const SelectRoutingDecisionSchema = createSelectSchema(
  schema.routingDecisionsTable,
  {
    sessionKey: RoutingSessionKeySchema,
    reason: RoutingDecisionReasonSchema,
    features: RoutingDecisionFeaturesSchema.nullable(),
  },
);
export const InsertRoutingDecisionSchema = createInsertSchema(
  schema.routingDecisionsTable,
  {
    sessionKey: RoutingSessionKeySchema,
    reason: RoutingDecisionReasonSchema,
    features: RoutingDecisionFeaturesSchema.nullable(),
  },
).omit({ id: true, createdAt: true });
export type RoutingDecision = z.infer<typeof SelectRoutingDecisionSchema>;
export type InsertRoutingDecision = z.infer<typeof InsertRoutingDecisionSchema>;

export const InsertRoutingUsageSchema = createInsertSchema(
  schema.routingUsageTable,
).omit({ createdAt: true });
export type InsertRoutingUsage = z.infer<typeof InsertRoutingUsageSchema>;

export const SelectRoutingPlanSchema = createSelectSchema(
  schema.routingPlansTable,
  {
    trigger: RoutingPlanTriggerSchema,
    status: RoutingPlanStatusSchema,
    tiersFingerprint: RouterDocumentSchema,
    plan: RouterDocumentSchema.nullable(),
    summary: RouterDocumentSchema.nullable(),
    diagnostics: RouterDocumentSchema.nullable(),
  },
);
export type RoutingPlan = z.infer<typeof SelectRoutingPlanSchema>;

/** The tiers auto routing chooses between: the organization's default model trio. */
const AutoRoutingTrioSchema = z.object({
  fastModelId: z.string().uuid().nullable(),
  normalModelId: z.string().uuid().nullable(),
  smartModelId: z.string().uuid().nullable(),
});
export type AutoRoutingTrio = z.infer<typeof AutoRoutingTrioSchema>;

/**
 * Auto-routing settings of an organization, stored on its LLM Proxy row. The
 * tiers are read from the organization's default model trio.
 */
export const AutoRoutingSettingsSchema = AutoRoutingTrioSchema.extend({
  enabled: z.boolean(),
  budgetUsdPerDay: z.string().nullable(),
  scorerVersionId: z.string().uuid().nullable(),
  /** Bumped by every write of plan-relevant state; a fit publishes only at the generation it read. */
  generation: z.number().int(),
  /** Generation of the last fit outcome; behind `generation` means a fit is due. */
  plannedGeneration: z.number().int(),
});
export type AutoRoutingSettings = z.infer<typeof AutoRoutingSettingsSchema>;

export const UpdateAutoRoutingSettingsSchema = AutoRoutingSettingsSchema.pick({
  enabled: true,
  budgetUsdPerDay: true,
}).partial();
export type UpdateAutoRoutingSettings = z.infer<
  typeof UpdateAutoRoutingSettingsSchema
>;

/** What a fit produced. Only `active` replaces the serving plan; `cold_start` retires it. */
export type RoutingFitOutcome =
  | {
      status: "active";
      plan: RouterDocument;
      summary: RouterDocument | null;
      diagnostics: RouterDocument | null;
    }
  | {
      status: "cold_start";
      summary: RouterDocument | null;
      diagnostics: RouterDocument | null;
    }
  | { status: "failed"; error: string; diagnostics: RouterDocument | null };

/** A finished fit and the inputs it read, offered to the publisher. */
export type RoutingFit = {
  organizationId: string;
  trigger: RoutingPlanTrigger;
  /** `AutoRoutingSettings.generation` when the fit read its inputs. */
  generation: number;
  inputWatermark: Date;
  tiersFingerprint: RouterDocument;
  budgetUsdPerDay: string;
  scorerVersionId: string;
  coreVersion: string;
  planFormatVersion: number;
  outcome: RoutingFitOutcome;
};

export const RoutingPublishRejectionSchema = z.enum([
  "stale_generation",
  "stale_scorer_version",
  "stale_watermark",
]);
export type RoutingPublishRejection = z.infer<
  typeof RoutingPublishRejectionSchema
>;

export type RoutingPublishResult =
  | { kind: "recorded"; plan: RoutingPlan }
  | { kind: "rejected"; reason: RoutingPublishRejection; plan: RoutingPlan };

export type AutoRoutingRequestContext = {
  decisionId: string;
  smartModel: {
    modelId: string;
    provider: SupportedProvider;
    /** The provider instance the smart tier would be served by for this credential. */
    providerApiKeyId: string;
  };
  /** The routing key standing in for a session id the client did not send. */
  derivedSessionKey: RoutingSessionKey | null;
};

/** A plan row with the scorer version it was fitted for and the sessions it routed. */
export const RoutingPlanRecordSchema = z.object({
  plan: SelectRoutingPlanSchema,
  scorerVersion: SelectRoutingScorerVersionSchema.pick({
    id: true,
    name: true,
    model: true,
    specHash: true,
  }),
  decisionCount: z.number().int().nonnegative(),
});
export type RoutingPlanRecord = z.infer<typeof RoutingPlanRecordSchema>;

export const RoutingBackfillStatusSchema = z.enum([
  "running",
  /** The scan finished; scoring waits for an admin to start it. */
  "scanned",
  "done",
  "failed",
  "cancelled",
  /** Replaced by a newer scan, or its scorer version is no longer the running one. */
  "superseded",
]);
export type RoutingBackfillStatus = z.infer<typeof RoutingBackfillStatusSchema>;

export const RoutingBackfillPhaseSchema = z.enum(["scan", "score"]);
export type RoutingBackfillPhase = z.infer<typeof RoutingBackfillPhaseSchema>;

/** The request shapes whose past sessions a backfill learns from. */
export const RoutingApiShapeSchema = z.enum([
  "chat_completions",
  "responses",
  "messages",
]);
export type RoutingApiShape = z.infer<typeof RoutingApiShapeSchema>;

/** Eligible sessions of a scan by request shape and client. */
export const RoutingBackfillBreakdownSchema = z.array(
  z.object({
    apiShape: RoutingApiShapeSchema,
    client: z.string(),
    sessions: z.number().int().nonnegative(),
  }),
);
export type RoutingBackfillBreakdown = z.infer<
  typeof RoutingBackfillBreakdownSchema
>;

export const RoutingHistoryScoreStatusSchema = z.enum([
  /** A paid call is under way or its reading did not land; read again until the attempts run out. */
  "pending",
  "scored",
  /** No opening text to score: withheld, encrypted, a delta suffix, or no main turn. */
  "no_text",
  /** The scorer answered something unusable, or every paid attempt was spent; not retried for this version. */
  "failed",
]);
export type RoutingHistoryScoreStatus = z.infer<
  typeof RoutingHistoryScoreStatusSchema
>;

export const SelectRoutingBackfillSchema = createSelectSchema(
  schema.routingBackfillsTable,
  {
    status: RoutingBackfillStatusSchema,
    phase: RoutingBackfillPhaseSchema,
    breakdown: RoutingBackfillBreakdownSchema,
  },
);
export type RoutingBackfill = z.infer<typeof SelectRoutingBackfillSchema>;

export const SelectRoutingHistorySessionSchema = createSelectSchema(
  schema.routingHistorySessionsTable,
  { apiShape: RoutingApiShapeSchema },
);
export type RoutingHistorySession = z.infer<
  typeof SelectRoutingHistorySessionSchema
>;
