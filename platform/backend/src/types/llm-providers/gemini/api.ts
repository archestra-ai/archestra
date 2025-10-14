import { z } from "zod";
import { ContentSchema } from "./messages";
import { FunctionDeclarationSchema, ToolConfigSchema } from "./tools";

/**
 * Gemini API Key Schema
 * Gemini uses API key as a query parameter or header
 */
export const ApiKeySchema = z.string().describe("API key for Google Gemini");

/**
 * Safety Settings
 */
export const HarmCategorySchema = z.enum([
  "HARM_CATEGORY_UNSPECIFIED",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
]);

export const HarmBlockThresholdSchema = z.enum([
  "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
  "BLOCK_NONE",
  "BLOCK_ONLY_HIGH",
  "BLOCK_MEDIUM_AND_ABOVE",
  "BLOCK_LOW_AND_ABOVE",
]);

export const SafetySettingSchema = z.object({
  category: HarmCategorySchema,
  threshold: HarmBlockThresholdSchema,
});

/**
 * Generation Config
 */
export const GenerationConfigSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  candidateCount: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
  responseMimeType: z.string().optional(),
  responseSchema: z.any().optional(),
});

/**
 * System Instruction
 */
export const SystemInstructionSchema = z.object({
  parts: z.array(
    z.object({
      text: z.string(),
    }),
  ),
});

/**
 * Generate Content Request Schema
 */
export const GenerateContentRequestSchema = z.object({
  contents: z.array(ContentSchema),
  tools: z
    .array(
      z.object({
        functionDeclarations: z.array(FunctionDeclarationSchema),
      }),
    )
    .optional(),
  toolConfig: ToolConfigSchema.optional(),
  safetySettings: z.array(SafetySettingSchema).optional(),
  systemInstruction: SystemInstructionSchema.optional(),
  generationConfig: GenerationConfigSchema.optional(),
});

/**
 * Candidate Schema
 */
export const CandidateSchema = z.object({
  content: ContentSchema.optional(),
  finishReason: z
    .enum([
      "FINISH_REASON_UNSPECIFIED",
      "STOP",
      "MAX_TOKENS",
      "SAFETY",
      "RECITATION",
      "OTHER",
    ])
    .optional(),
  index: z.number().optional(),
  safetyRatings: z
    .array(
      z.object({
        category: HarmCategorySchema,
        probability: z.enum([
          "HARM_PROBABILITY_UNSPECIFIED",
          "NEGLIGIBLE",
          "LOW",
          "MEDIUM",
          "HIGH",
        ]),
        blocked: z.boolean().optional(),
      }),
    )
    .optional(),
  citationMetadata: z
    .object({
      citations: z
        .array(
          z.object({
            startIndex: z.number().optional(),
            endIndex: z.number().optional(),
            uri: z.string().optional(),
            license: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  tokenCount: z.number().optional(),
});

/**
 * Usage Metadata
 */
export const UsageMetadataSchema = z.object({
  promptTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
  totalTokenCount: z.number().optional(),
});

/**
 * Generate Content Response Schema
 */
export const GenerateContentResponseSchema = z.object({
  candidates: z.array(CandidateSchema).optional(),
  promptFeedback: z
    .object({
      blockReason: z
        .enum([
          "BLOCK_REASON_UNSPECIFIED",
          "SAFETY",
          "OTHER",
          "BLOCKLIST",
          "PROHIBITED_CONTENT",
        ])
        .optional(),
      safetyRatings: z
        .array(
          z.object({
            category: HarmCategorySchema,
            probability: z.enum([
              "HARM_PROBABILITY_UNSPECIFIED",
              "NEGLIGIBLE",
              "LOW",
              "MEDIUM",
              "HIGH",
            ]),
            blocked: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  usageMetadata: UsageMetadataSchema.optional(),
  modelVersion: z.string().optional(),
});

/**
 * Stream Generate Content Response Schema (for SSE chunks)
 */
export const StreamGenerateContentChunkSchema = GenerateContentResponseSchema;
