import {
  ModelInputModalitySchema,
  ModelOutputModalitySchema,
  SupportedEmbeddingDimensionsSchema,
  SupportedProvidersSchema,
} from "@archestra/shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export type {
  ModelInputModality,
  ModelOutputModality,
} from "@archestra/shared";
// Re-export modality schemas and types from @archestra/shared for convenience
export {
  ModelInputModalitySchema,
  ModelOutputModalitySchema,
} from "@archestra/shared";

/**
 * Fields to extend for drizzle-zod schema generation.
 */
const fieldsToExtend = {
  provider: SupportedProvidersSchema,
  embeddingDimensions: SupportedEmbeddingDimensionsSchema.nullable(),
  inputModalities: z.array(ModelInputModalitySchema).nullable(),
  outputModalities: z.array(ModelOutputModalitySchema).nullable(),
};

/**
 * Base database schema derived from Drizzle with strongly typed modalities.
 */
export const SelectModelSchema = createSelectSchema(
  schema.modelsTable,
  fieldsToExtend,
);
export const InsertModelSchema = createInsertSchema(
  schema.modelsTable,
  fieldsToExtend,
);

/**
 * Schema for creating new model (without auto-generated fields)
 */
export const CreateModelSchema = InsertModelSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  embeddingDimensions: SupportedEmbeddingDimensionsSchema.nullable().optional(),
});

/**
 * Exported types
 */
export type Model = z.infer<typeof SelectModelSchema>;
export type InsertModel = z.infer<typeof InsertModelSchema>;
export type CreateModel = z.infer<typeof CreateModelSchema>;

/**
 * Price source indicates where the effective price comes from.
 *
 * - `custom`: admin-set override.
 * - `models_dev`: synced from the models.dev registry.
 * - `derived_multiplier`: cache price derived from the input price via a provider
 *   multiplier (used only for cache prices when the registry omits them).
 * - `default`: estimated flat fallback — a guess, surfaced as such in the UI.
 */
export const PriceSourceSchema = z.enum([
  "custom",
  "models_dev",
  "derived_multiplier",
  "default",
]);
export type PriceSource = z.infer<typeof PriceSourceSchema>;

/**
 * Model capabilities for API responses.
 * Derived from SelectModelSchema with computed price fields.
 */
export const ModelCapabilitiesSchema = SelectModelSchema.pick({
  contextLength: true,
  inputModalities: true,
  outputModalities: true,
  supportsToolCalling: true,
}).extend({
  /** Price per million tokens for input (computed from per-token price) */
  pricePerMillionInput: z.string().nullable(),
  /** Price per million tokens for output (computed from per-token price) */
  pricePerMillionOutput: z.string().nullable(),
  /** Whether the price is a custom admin-set override */
  isCustomPrice: z.boolean(),
  /** Source of the effective input/output price */
  priceSource: PriceSourceSchema,
  /** Price per million cache-read tokens, or null when not priced */
  pricePerMillionCacheRead: z.string().nullable(),
  /** Price per million cache-write tokens (default TTL), or null when not priced */
  pricePerMillionCacheWrite: z.string().nullable(),
  /** Source of the effective cache price (null when cache is unpriced) */
  cachePriceSource: PriceSourceSchema.nullable(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/**
 * Schema for updating model details (pricing + modalities) from the edit dialog.
 */
export const PatchModelBodySchema = createUpdateSchema(
  schema.modelsTable,
  fieldsToExtend,
)
  .pick({
    customPricePerMillionInput: true,
    customPricePerMillionOutput: true,
    customPricePerMillionCacheRead: true,
    customPricePerMillionCacheWrite: true,
    ignored: true,
    embeddingDimensions: true,
    inputModalities: true,
    outputModalities: true,
  })
  .extend({
    customPricePerMillionInput: z.string().nullable().optional(),
    customPricePerMillionOutput: z.string().nullable().optional(),
    customPricePerMillionCacheRead: z.string().nullable().optional(),
    customPricePerMillionCacheWrite: z.string().nullable().optional(),
    ignored: z.boolean().optional(),
    embeddingDimensions:
      SupportedEmbeddingDimensionsSchema.nullable().optional(),
    inputModalities: z
      .array(ModelInputModalitySchema)
      .min(1, "At least one input modality is required")
      .nullable()
      .optional(),
    outputModalities: z.array(ModelOutputModalitySchema).nullable().optional(),
  })
  .refine(
    (data) => {
      // If either pricing field is provided, both must be provided
      const inputProvided = data.customPricePerMillionInput !== undefined;
      const outputProvided = data.customPricePerMillionOutput !== undefined;
      if (inputProvided !== outputProvided) return false;
      // If both provided, both must be null or both non-null
      if (inputProvided && outputProvided) {
        const inputSet = data.customPricePerMillionInput !== null;
        const outputSet = data.customPricePerMillionOutput !== null;
        if (inputSet !== outputSet) return false;
      }
      return true;
    },
    {
      message: "Both custom prices must be set together or both must be null",
    },
  )
  .refine(
    (data) => {
      if (data.embeddingDimensions != null) {
        return true;
      }

      if (data.outputModalities == null) {
        return true;
      }

      return data.outputModalities.length > 0;
    },
    {
      message: "At least one output modality is required",
      path: ["outputModalities"],
    },
  )
  .refine(
    (data) => {
      // Cache read/write overrides must be set together or both null.
      const readProvided = data.customPricePerMillionCacheRead !== undefined;
      const writeProvided = data.customPricePerMillionCacheWrite !== undefined;
      if (readProvided !== writeProvided) return false;
      if (readProvided && writeProvided) {
        const readSet = data.customPricePerMillionCacheRead !== null;
        const writeSet = data.customPricePerMillionCacheWrite !== null;
        if (readSet !== writeSet) return false;
      }
      return true;
    },
    {
      message:
        "Both custom cache prices must be set together or both must be null",
    },
  )
  .refine(
    (data) => {
      for (const value of [
        data.customPricePerMillionInput,
        data.customPricePerMillionOutput,
        data.customPricePerMillionCacheRead,
        data.customPricePerMillionCacheWrite,
      ]) {
        if (value != null) {
          const price = parseFloat(value);
          if (Number.isNaN(price) || price < 0) return false;
        }
      }
      return true;
    },
    { message: "Prices must be non-negative numbers" },
  );
export type PatchModelBody = z.infer<typeof PatchModelBodySchema>;

/**
 * Schema for linked API key info (minimal info for display)
 */
export const LinkedApiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  provider: z.string(),
  scope: z.string(),
  isSystem: z.boolean(),
});
export type LinkedApiKey = z.infer<typeof LinkedApiKeySchema>;

/**
 * Schema for model with linked API keys (for settings page display)
 */
export const ModelWithApiKeysSchema = SelectModelSchema.extend({
  /** Whether this model is marked as the best (highest quality) for any linked API key */
  isBest: z.boolean(),
  /** API keys that provide access to this model */
  apiKeys: z.array(LinkedApiKeySchema),
  /** Price per million tokens for input (computed from raw/custom pricing) */
  pricePerMillionInput: z.string().nullable(),
  /** Price per million tokens for output (computed from raw/custom pricing) */
  pricePerMillionOutput: z.string().nullable(),
  /** Whether the effective price is a custom admin-set override */
  isCustomPrice: z.boolean(),
  /** Source of the effective input/output price */
  priceSource: PriceSourceSchema,
  /** Price per million cache-read tokens, or null when not priced */
  pricePerMillionCacheRead: z.string().nullable(),
  /** Price per million cache-write tokens (default TTL), or null when not priced */
  pricePerMillionCacheWrite: z.string().nullable(),
  /** Source of the effective cache price (null when cache is unpriced) */
  cachePriceSource: PriceSourceSchema.nullable(),
  /** True when the provider charges nothing for this model (both raw prices are zero). */
  isFree: z.boolean(),
});
export type ModelWithApiKeys = z.infer<typeof ModelWithApiKeysSchema>;
