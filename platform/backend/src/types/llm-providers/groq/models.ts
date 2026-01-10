/**
 * Groq Model Types
 *
 * Groq uses OpenAI-compatible model listing format.
 * See: https://console.groq.com/docs/models
 */
import { z } from "zod";

export const ModelSchema = z
  .object({
    id: z
      .string()
      .describe(
        "The model identifier, which can be referenced in the API endpoints.",
      ),
    created: z
      .number()
      .describe("The Unix timestamp (in seconds) when the model was created."),
    object: z
      .enum(["model"])
      .describe('The object type, which is always "model".'),
    owned_by: z.string().describe("The organization that owns the model."),
    // Groq-specific fields
    active: z.boolean().optional().describe("Whether the model is active"),
    context_window: z
      .number()
      .optional()
      .describe("The maximum context window size in tokens"),
  })
  .describe("A Groq model object");

export const ModelsListResponseSchema = z
  .object({
    object: z.enum(["list"]),
    data: z.array(ModelSchema),
  })
  .describe("Groq models list response");
