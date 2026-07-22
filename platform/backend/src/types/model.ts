import {
  MAX_CONFIGURABLE_NUM_CTX,
  MAX_STOP_SEQUENCE_LENGTH,
  MAX_STOP_SEQUENCES,
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
 * Ollama model default generation parameters, pulled from `/api/show`.
 * A free-form key/value map (e.g. num_ctx, temperature, stop); repeated keys
 * such as `stop` are collected into an array. Stored for display only — nothing
 * applies these at request time.
 */
const ModelDefaultParametersSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.array(z.string())]),
);
export type ModelDefaultParameters = z.infer<
  typeof ModelDefaultParametersSchema
>;

/**
 * Thinking-effort levels for Ollama's native `think` parameter.
 * `none` → `think: false`; the rest map to the native string levels.
 */
export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/**
 * Re-exported from `@archestra/shared` so backend callers keep importing these
 * from the module that owns the schema they bound. The frontend form imports
 * the same constants directly to mirror these rules.
 */
export type {
  MAX_CONFIGURABLE_NUM_CTX,
  MAX_STOP_SEQUENCE_LENGTH,
  MAX_STOP_SEQUENCES,
};

/**
 * Admin-configured, per-model generation parameters that Archestra SENDS on
 * every native Ollama (`ollama-native`) chat turn (unlike `defaultParameters`,
 * which is display-only). Each field is optional — an omitted field inherits
 * Ollama's own Modelfile/server default. Precedence at request time is:
 * request body > these configured values > omitted.
 *
 * Only `ollama-native` models accept these — the update route rejects them for
 * every other provider, since nothing else ever sends them and a stray value
 * would still redefine the displayed context window (see
 * `ModelModel.resolveEffectiveContextLength`).
 */
export const ConfiguredParametersSchema = z.object({
  temperature: z.number().min(0).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).optional(),
  repeat_penalty: z.number().min(0).optional(),
  seed: z.number().int().optional(),
  /**
   * Bounded on both axes: this row is world-readable to anyone with
   * `llmModel:read` and is serialized into every native turn, so an unbounded
   * array would be a cheap way to bloat both. Ollama only ever uses a handful
   * of stop sequences.
   */
  stop: z
    .array(z.string().max(MAX_STOP_SEQUENCE_LENGTH))
    .max(MAX_STOP_SEQUENCES)
    .optional(),
  /**
   * Upper bound is a sanity backstop. The update route additionally rejects
   * anything above the model's own architectural `contextLength` — but only
   * when that is known: a proxy-discovered row can have a null `contextLength`,
   * and then this bound is the only ceiling. An unbounded value here would make
   * Ollama allocate (or refuse) an absurd KV cache while Archestra kept
   * displaying the inflated window.
   */
  num_ctx: z.number().int().min(1).max(MAX_CONFIGURABLE_NUM_CTX).optional(),
  /** `-1` = generate until the context fills, `-2` = fill the context. */
  num_predict: z.number().int().min(-2).optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
});
export type ConfiguredParameters = z.infer<typeof ConfiguredParametersSchema>;

/**
 * Fields to extend for drizzle-zod schema generation.
 */
const fieldsToExtend = {
  provider: SupportedProvidersSchema,
  embeddingDimensions: SupportedEmbeddingDimensionsSchema.nullable(),
  inputModalities: z.array(ModelInputModalitySchema).nullable(),
  outputModalities: z.array(ModelOutputModalitySchema).nullable(),
  defaultParameters: ModelDefaultParametersSchema.nullable(),
  configuredParameters: ConfiguredParametersSchema.nullable(),
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
  defaultParameters: ModelDefaultParametersSchema.nullable().optional(),
  configuredParameters: ConfiguredParametersSchema.nullable().optional(),
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
    configuredParameters: true,
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
    // Per-model generation parameters sent on every native Ollama chat turn.
    configuredParameters: ConfiguredParametersSchema.nullable().optional(),
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
  /**
   * Context window the model will actually enforce, from
   * `ModelModel.resolveEffectiveContextLength`. **Use this for display.**
   *
   * The inherited `contextLength` is the *architectural* window and stays the
   * ceiling that `num_ctx` is validated against, so it must not be overwritten
   * with this value — doing so would cap `num_ctx` at an Ollama Modelfile's
   * default and make raising the window impossible.
   */
  effectiveContextLength: z.number().nullable(),
});
export type ModelWithApiKeys = z.infer<typeof ModelWithApiKeysSchema>;
