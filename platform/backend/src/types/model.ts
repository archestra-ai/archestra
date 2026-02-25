import {
  ModelInputModalitySchema,
  ModelOutputModalitySchema,
  SupportedProvidersSchema,
} from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export type { ModelInputModality, ModelOutputModality } from "@shared";
// Re-export modality schemas and types from @shared for convenience
export { ModelInputModalitySchema, ModelOutputModalitySchema } from "@shared";

/**
 * Fields to extend for drizzle-zod schema generation.
 */
const fieldsToExtend = {
  provider: SupportedProvidersSchema,
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
});

/**
 * Schema for updating model (all fields optional)
 */
export const UpdateModelSchema = CreateModelSchema.partial();

/**
 * Exported types
 */
export type Model = z.infer<typeof SelectModelSchema>;
export type InsertModel = z.infer<typeof InsertModelSchema>;
export type CreateModel = z.infer<typeof CreateModelSchema>;
export type UpdateModel = z.infer<typeof UpdateModelSchema>;

/**
 * Price source indicates where the effective price comes from.
 */
export const PriceSourceSchema = z.enum(["custom", "models_dev", "default"]);
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
  /** Source of the effective price */
  priceSource: PriceSourceSchema,
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/**
 * Schema for updating custom model pricing
 */
export const UpdateModelPricingSchema = z
  .object({
    customPricePerMillionInput: z.string().nullable(),
    customPricePerMillionOutput: z.string().nullable(),
  })
  .refine(
    (data) => {
      const inputSet = data.customPricePerMillionInput !== null;
      const outputSet = data.customPricePerMillionOutput !== null;
      return inputSet === outputSet;
    },
    {
      message: "Both custom prices must be set together or both must be null",
    },
  )
  .refine(
    (data) => {
      if (data.customPricePerMillionInput !== null) {
        const price = parseFloat(data.customPricePerMillionInput);
        if (Number.isNaN(price) || price < 0) return false;
      }
      if (data.customPricePerMillionOutput !== null) {
        const price = parseFloat(data.customPricePerMillionOutput);
        if (Number.isNaN(price) || price < 0) return false;
      }
      return true;
    },
    { message: "Prices must be non-negative numbers" },
  );
export type UpdateModelPricing = z.infer<typeof UpdateModelPricingSchema>;

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
  /** Whether this model is marked as the fastest (lowest latency) for any linked API key */
  isFastest: z.boolean(),
  /** Whether this model is marked as the best (highest quality) for any linked API key */
  isBest: z.boolean(),
  /** API keys that provide access to this model */
  apiKeys: z.array(LinkedApiKeySchema),
  /** Computed capabilities with pricing */
  capabilities: ModelCapabilitiesSchema,
});
export type ModelWithApiKeys = z.infer<typeof ModelWithApiKeysSchema>;
