import { SupportedProvidersSchema } from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Input modality types supported by models.
 * - text: Standard text input
 * - image: Image files (PNG, JPEG, etc.)
 * - audio: Audio files
 * - video: Video files
 * - file: Document files (PDF, etc.)
 */
export const InputModalitySchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "file",
]);
export type InputModality = z.infer<typeof InputModalitySchema>;

/**
 * Output modality types supported by models.
 * - text: Standard text output
 * - image: Image generation
 * - audio: Audio generation
 */
export const OutputModalitySchema = z.enum(["text", "image", "audio"]);
export type OutputModality = z.infer<typeof OutputModalitySchema>;

const fieldsToExtend = {
  provider: SupportedProvidersSchema,
};

/**
 * Base database schema derived from Drizzle.
 * Note: inputModalities and outputModalities are typed as string[] in the DB layer.
 * Use InputModality[] and OutputModality[] types when working with these at the app layer.
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
export type ModelMetadata = z.infer<typeof SelectModelMetadataSchema>;
export type InsertModelMetadata = z.infer<typeof InsertModelMetadataSchema>;
export type CreateModelMetadata = z.infer<typeof CreateModelMetadataSchema>;
export type UpdateModelMetadata = z.infer<typeof UpdateModelMetadataSchema>;

/**
 * Model capabilities summary for API responses.
 * This is a simplified view of model metadata for frontend consumption.
 */
export const ModelCapabilitiesSchema = z.object({
  /** Maximum context window size in tokens */
  contextLength: z.number().nullable(),
  /** Supported input modalities (text, image, audio, video, file) */
  inputModalities: z.array(z.string()).nullable(),
  /** Supported output modalities (text, image, audio) */
  outputModalities: z.array(z.string()).nullable(),
  /** Whether the model supports function/tool calling */
  supportsToolCalling: z.boolean().nullable(),
  /** Price per million tokens for input */
  pricePerMillionInput: z.string().nullable(),
  /** Price per million tokens for output */
  pricePerMillionOutput: z.string().nullable(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
