/**
 * Z.ai Model Schemas
 * @see https://docs.z.ai/api-reference/llm/chat-completion
 */
import { z } from "zod";

export const ModelSchema = z.object({
  id: z.string().describe("The model identifier."),
  created: z
    .number()
    .describe("The Unix timestamp (in seconds) when the model was created."),
  object: z.enum(["model"]).describe('The object type, which is always "model".'),
  owned_by: z.string().describe("The organization that owns the model."),
});

// Z.ai compatible model schema
export const ZaiModelSchema = z.object({
  id: z.string().describe("The model identifier."),
  name: z.string().optional().describe("The model name."),
});
