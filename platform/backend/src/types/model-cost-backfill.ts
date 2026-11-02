import { SupportedProvidersSchema } from "@archestra/shared";
import { isValidModelPrice } from "@archestra/shared/model-price";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { PriceSourceSchema } from "./model";

/**
 * pending: created, not yet claimed by a worker.
 * running: a worker has claimed it at least once; resumes from its cursor.
 * completed / failed: terminal.
 */
export const ModelCostBackfillStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);
export type ModelCostBackfillStatus = z.infer<
  typeof ModelCostBackfillStatusSchema
>;

/**
 * main: walking [since, cutoff) once.
 * sweep: one more pass over the last minutes before the cutoff, for requests
 * that were in flight when the prices changed and committed after the main
 * pass had moved on.
 */
export const ModelCostBackfillPhaseSchema = z.enum(["main", "sweep"]);
export type ModelCostBackfillPhase = z.infer<
  typeof ModelCostBackfillPhaseSchema
>;

/** One resolved price set; same shape as `ModelModel.getEffectivePricing`. */
const CostBackfillPriceSetSchema = z.object({
  pricePerMillionInput: z.string().nullable(),
  pricePerMillionOutput: z.string().nullable(),
  pricePerMillionCacheRead: z.string().nullable(),
  pricePerMillionCacheWrite: z.string().nullable(),
  source: PriceSourceSchema,
  cacheSource: PriceSourceSchema.nullable(),
});

/**
 * The prices a backfill recomputes with, frozen when it starts so a later edit
 * cannot change a running job: the base prices, plus the model's long-context
 * tier for requests whose prompt exceeds its threshold. Backfills started
 * before long-context pricing have no tier.
 */
export const ModelCostBackfillPricingSchema = CostBackfillPriceSetSchema.extend(
  {
    provider: SupportedProvidersSchema,
    longContext: z
      .object({
        threshold: z.number().int().positive(),
        prices: CostBackfillPriceSetSchema,
      })
      .nullable()
      .optional(),
  },
);
export type ModelCostBackfillPricing = z.infer<
  typeof ModelCostBackfillPricingSchema
>;

export const SelectModelCostBackfillSchema = createSelectSchema(
  schema.modelCostBackfillsTable,
  {
    status: ModelCostBackfillStatusSchema,
    phase: ModelCostBackfillPhaseSchema,
    pricing: ModelCostBackfillPricingSchema,
  },
);
export type ModelCostBackfill = z.infer<typeof SelectModelCostBackfillSchema>;

/** What the API shows of a backfill; lease bookkeeping stays internal. */
export const ModelCostBackfillResponseSchema =
  SelectModelCostBackfillSchema.pick({
    id: true,
    modelId: true,
    since: true,
    cutoff: true,
    status: true,
    rowsEstimated: true,
    rowsScanned: true,
    rowsUpdated: true,
    error: true,
    createdAt: true,
    completedAt: true,
  });

/**
 * Whether a model's recorded costs can be recomputed:
 * - available
 * - index_pending: the model-history index is still being built (worker
 *   startup, minutes on a large table); every query would scan the table.
 * - provider_reported_cost: the provider reports what requests actually cost
 *   (OpenRouter) and rows don't record which costs were reported, so
 *   recomputing would overwrite real charges with estimates.
 * - needs_custom_price: provider keys publish their own per-key price
 *   (LiteLLM) and rows don't record which key served them; only an explicit
 *   custom price gives one price for all of them.
 */
export const CostBackfillAvailabilitySchema = z.enum([
  "available",
  "index_pending",
  "provider_reported_cost",
  "needs_custom_price",
]);
export type CostBackfillAvailability = z.infer<
  typeof CostBackfillAvailabilitySchema
>;

const PriceInputSchema = z
  .string()
  .refine(
    isValidModelPrice,
    "Prices must be decimal numbers between 0 and 99999999.99",
  )
  .nullable();

/** Custom prices per million tokens, as typed in the edit form (unsaved). */
export const CostBackfillPricesSchema = z.object({
  input: PriceInputSchema,
  output: PriceInputSchema,
  cacheRead: PriceInputSchema,
  cacheWrite: PriceInputSchema,
});
export type CostBackfillPrices = z.infer<typeof CostBackfillPricesSchema>;

export const CostBackfillPreviewSchema = z.object({
  availability: CostBackfillAvailabilitySchema,
  /** Provider keys price this model (LiteLLM): past requests use the custom price. */
  instancePriced: z.boolean(),
  /** Eligible requests per calendar day, oldest first; empty unless available. */
  days: z.array(
    z.object({
      /** YYYY-MM-DD in the requested time zone. */
      day: z.string(),
      requests: z.number().int(),
      recordedCost: z.number(),
      recomputedCost: z.number(),
    }),
  ),
  /** What a backfill from `since` would recompute; null when `since` is omitted. */
  window: z
    .object({
      requests: z.number().int(),
      /** Requests on subscription credentials: recomputed, but never billed. */
      subscriptionRequests: z.number().int(),
      users: z.number().int(),
      recordedCost: z.number(),
      recomputedCost: z.number(),
    })
    .nullable(),
});
export type CostBackfillPreview = z.infer<typeof CostBackfillPreviewSchema>;
