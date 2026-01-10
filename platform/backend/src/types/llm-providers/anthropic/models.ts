import { z } from "zod";

export const ModelSchema = z
  .object({
    id: z.string().describe("Unique model identifier."),
    created_at: z
      .string()
      .describe(
        "RFC 3339 datetime string representing the time at which the model was released. May be set to an epoch value if the release date is unknown.",
      ),
    display_name: z.string().describe("A human-readable name for the model."),
    type: z
      .enum(["model"])
      .describe('Object type. For Models, this is always "model".'),
  })
  .describe("https://platform.claude.com/docs/en/api/models#model_info");
