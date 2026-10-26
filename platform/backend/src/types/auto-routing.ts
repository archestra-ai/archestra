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
  "nightly",
  "settings",
  "manual",
  "scorer_change",
]);
export type RoutingPlanTrigger = z.infer<typeof RoutingPlanTriggerSchema>;

export const RoutingPlanStatusSchema = z.enum([
  "active",
  "superseded",
  "failed",
  "cold_start",
]);
export type RoutingPlanStatus = z.infer<typeof RoutingPlanStatusSchema>;

/** router-core `SessionFeatures`, as sent to `decide` and fitted on. */
export const RoutingSessionFeaturesSchema = z.object({
  tier_needed: z.tuple([z.number(), z.number(), z.number()]),
  p_long: z.number().min(0).max(1),
  kind: z.enum(["main", "subagent"]),
  source: z.string(),
});
export type RoutingSessionFeatures = z.infer<
  typeof RoutingSessionFeaturesSchema
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
    features: RoutingSessionFeaturesSchema.nullable(),
  },
);
export const InsertRoutingDecisionSchema = createInsertSchema(
  schema.routingDecisionsTable,
  {
    sessionKey: RoutingSessionKeySchema,
    reason: RoutingDecisionReasonSchema,
    features: RoutingSessionFeaturesSchema.nullable(),
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

/** Auto-routing settings of an organization, stored on its LLM Proxy row. */
export const AutoRoutingSettingsSchema = z.object({
  enabled: z.boolean(),
  budgetUsdPerDay: z.string().nullable(),
  fastModelId: z.string().uuid().nullable(),
  normalModelId: z.string().uuid().nullable(),
  smartModelId: z.string().uuid().nullable(),
  scorerVersionId: z.string().uuid().nullable(),
  /** Bumped by every write of plan-relevant state; a fit publishes only at the generation it read. */
  generation: z.number().int(),
  /** Generation of the last fit outcome; behind `generation` means a fit is due. */
  plannedGeneration: z.number().int(),
});
export type AutoRoutingSettings = z.infer<typeof AutoRoutingSettingsSchema>;

export const UpdateAutoRoutingSettingsSchema = AutoRoutingSettingsSchema.omit({
  generation: true,
  plannedGeneration: true,
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
  smartModel: { modelId: string; provider: string };
};
