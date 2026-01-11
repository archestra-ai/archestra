import { z } from "zod";

export const ModelSchema = z
  .object({
    name: z
      .string()
      .describe("The resource name of the Model in format models/{model}."),
    baseModelId: z
      .string()
      .describe(
        "The name of the base model, pass this to the generation request.",
      ),
    version: z
      .string()
      .describe(
        "The version number of the model representing major version like 1.0 or 1.5.",
      ),
    displayName: z
      .string()
      .optional()
      .describe("The human-readable name of the model (up to 128 characters)."),
    description: z
      .string()
      .optional()
      .describe("A short description of the model."),
    inputTokenLimit: z
      .number()
      .int()
      .optional()
      .describe("Maximum number of input tokens allowed for this model."),
    outputTokenLimit: z
      .number()
      .int()
      .optional()
      .describe("Maximum number of output tokens available for this model."),
    supportedGenerationMethods: z
      .array(z.string())
      .optional()
      .describe(
        "The model's supported generation methods (e.g., generateContent).",
      ),
    thinking: z
      .boolean()
      .optional()
      .describe("Whether the model supports thinking."),
    temperature: z
      .number()
      .optional()
      .describe(
        "Controls randomness; ranges over [0.0, maxTemperature]. Higher values produce more random outputs.",
      ),
    maxTemperature: z
      .number()
      .optional()
      .describe("The maximum temperature this model can use."),
    topP: z
      .number()
      .optional()
      .describe(
        "For nucleus sampling; smallest set of tokens whose probability sum is at least topP.",
      ),
    topK: z
      .number()
      .int()
      .optional()
      .describe(
        "For top-k sampling; considers set of topK most probable tokens.",
      ),
  })
  .describe("https://ai.google.dev/api/models#Model");
