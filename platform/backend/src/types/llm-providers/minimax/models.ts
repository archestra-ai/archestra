import { z } from "zod";

// MiniMax model schemas
// Reference: https://platform.minimaxi.com/document/ChatCompletion%20v2

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
  .describe("Model object from MiniMax API");
