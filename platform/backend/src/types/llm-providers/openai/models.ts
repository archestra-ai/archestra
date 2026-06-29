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
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/models.ts#L41`,
  );

export const OrlandoModelSchema = z.object({
  id: z.string().describe("The model identifier."),
  name: z.string().describe("The model name."),
});
