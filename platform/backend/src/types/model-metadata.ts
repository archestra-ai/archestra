import { SupportedProvidersSchema } from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Zod schema for input modalities.
 * Matches the InputModality type from the database schema.
 */
export const ModelInputModalitySchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "file",
]);

/**
 * Zod schema for output modalities.
 * Matches the OutputModality type from the database schema.
 */
export const ModelOutputModalitySchema = z.enum(["text", "image", "audio"]);

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
export const SelectModelMetadataSchema = createSelectSchema(
  schema.modelMetadataTable,
  fieldsToExtend,
);
export const InsertModelMetadataSchema = createInsertSchema(
  schema.modelMetadataTable,
  fieldsToExtend,
);

/**
 * Schema for creating new model metadata (without auto-generated fields)
 */
export const CreateModelMetadataSchema = InsertModelMetadataSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

/**
 * Schema for updating model metadata (all fields optional)
 */
export const UpdateModelMetadataSchema = CreateModelMetadataSchema.partial();

/**
 * Exported types
 */
export type ModelInputModality = z.infer<typeof ModelInputModalitySchema>;
export type ModelOutputModality = z.infer<typeof ModelOutputModalitySchema>;

export type ModelMetadata = z.infer<typeof SelectModelMetadataSchema>;
export type InsertModelMetadata = z.infer<typeof InsertModelMetadataSchema>;
export type CreateModelMetadata = z.infer<typeof CreateModelMetadataSchema>;
export type UpdateModelMetadata = z.infer<typeof UpdateModelMetadataSchema>;

/**
 * Model capabilities for API responses.
 * Derived from SelectModelMetadataSchema with computed price fields.
 */
export const ModelCapabilitiesSchema = SelectModelMetadataSchema.pick({
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
