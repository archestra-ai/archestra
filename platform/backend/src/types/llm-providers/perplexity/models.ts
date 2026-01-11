/**
 * Perplexity Model Types
 *
 * Perplexity uses an OpenAI-compatible model listing format.
 * See: https://docs.perplexity.ai/api-reference/chat-completions-post
 *
 * Available models:
 * - sonar: Standard search model
 * - sonar-pro: Advanced search model with more capabilities
 * - sonar-reasoning: Search model with reasoning capabilities
 * - sonar-reasoning-pro: Advanced reasoning model
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
  })
  .describe("A Perplexity model object");

export const ModelsListResponseSchema = z
  .object({
    object: z.enum(["list"]),
    data: z.array(ModelSchema),
  })
  .describe("Perplexity models list response");
