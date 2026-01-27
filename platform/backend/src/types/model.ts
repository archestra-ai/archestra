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
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
