import { z } from "zod";

/**
 * Groq model schema
 * Groq uses OpenAI-compatible API format
 */
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
  })
  .describe(
    `Groq model object - compatible with OpenAI format`,
  );

/**
 * Available Groq models
 * See: https://console.groq.com/docs/models
 */
export const GroqModels = [
  // Llama models
  "llama-3.3-70b-versatile",
  "llama-3.1-70b-versatile", 
  "llama-3.1-8b-instant",
  "llama3-groq-70b-8192-tool-use-preview",
  "llama3-groq-8b-8192-tool-use-preview",
  "llama3-70b-8192",
  "llama3-8b-8192",
  // Mixtral
  "mixtral-8x7b-32768",
  // Gemma
  "gemma2-9b-it",
  "gemma-7b-it",
] as const;

export const GroqModelSchema = z.enum(GroqModels);
export type GroqModel = z.infer<typeof GroqModelSchema>;
