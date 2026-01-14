import { z } from "zod";

/**
 * Bedrock Foundation Model schemas
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html
 */

// Foundation model summary
export const FoundationModelSchema = z.object({
  modelArn: z.string().optional(),
  modelId: z.string(),
  modelName: z.string().optional(),
  providerName: z.string().optional(),
  inputModalities: z.array(z.string()).optional(),
  outputModalities: z.array(z.string()).optional(),
  responseStreamingSupported: z.boolean().optional(),
  customizationsSupported: z.array(z.string()).optional(),
  inferenceTypesSupported: z.array(z.string()).optional(),
  modelLifecycle: z
    .object({
      status: z.enum(["ACTIVE", "LEGACY"]).optional(),
    })
    .optional(),
});

export type FoundationModel = z.infer<typeof FoundationModelSchema>;
