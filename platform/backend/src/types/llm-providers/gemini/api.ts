import { z } from "zod";
import { ContentSchema } from "./messages";
import { ToolConfigSchema, ToolSchema } from "./tools";

const HarmCategorySchema = z
  .enum([
    "HARM_CATEGORY_UNSPECIFIED",
    "HARM_CATEGORY_DEROGATORY",
    "HARM_CATEGORY_TOXICITY",
    "HARM_CATEGORY_VIOLENCE",
    "HARM_CATEGORY_SEXUAL",
    "HARM_CATEGORY_MEDICAL",
    "HARM_CATEGORY_DANGEROUS",
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
    "HARM_CATEGORY_CIVIC_INTEGRITY",
  ])
  .describe(`
  The category for this setting

  https://ai.google.dev/api/generate-content#v1beta.HarmCategory
`);

const HarmProbabilitySchema = z
  .enum(["HARM_PROBABILITY_UNSPECIFIED", "NEGLIGIBLE", "LOW", "MEDIUM", "HIGH"])
  .describe(`https://ai.google.dev/api/generate-content#HarmProbability`);

const SafetySettingSchema = z
  .object({
    category: HarmCategorySchema,
    threshold: z
      .enum([
        "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
        "BLOCK_LOW_AND_ABOVE",
        "BLOCK_MEDIUM_AND_ABOVE",
        "BLOCK_ONLY_HIGH",
        "BLOCK_NONE",
        "OFF",
      ])
      .describe(`
      Controls the probability threshold at which harm is blocked.

      https://ai.google.dev/api/generate-content#HarmBlockThreshold
      `),
  })
  .describe(`https://ai.google.dev/api/generate-content#v1beta.SafetySetting`);

const SafetyRatingSchema = z
  .object({
    category: HarmCategorySchema,
    probability: HarmProbabilitySchema,
    blocked: z
      .boolean()
      .optional()
      .describe("Was this content blocked because of this rating?"),
  })
  .describe(`https://ai.google.dev/api/generate-content#v1beta.SafetyRating`);

const ModalitySchema = z
  .enum(["MODALITY_UNSPECIFIED", "TEXT", "IMAGE", "AUDIO"])
  .describe(`https://ai.google.dev/api/generate-content#Modality`);

const GenerationConfigSchema = z
  .object({
    stopSequences: z.array(z.string()).optional(),
    responseMimeType: z.string().optional(),
    responseSchema: z.any().optional(),
    _responseJsonSchema: z.any().optional(),
    responseJsonSchema: z.any().optional(),
    responseModalities: z.array(ModalitySchema).optional(),
    candidateCount: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    seed: z.number().optional(),
    presencePenalty: z.number().optional(),
    frequencyPenalty: z.number().optional(),
    responseLogprobs: z.boolean().optional(),
    logProbs: z.number().optional(),
    enableEnhancedCivicAnswers: z.boolean().optional(),
    speechConfig: z.any().optional(),
    thinkingConfig: z.any().optional(),
    imageConfig: z.any().optional(),
    mediaResolution: z
      .enum([
        "MEDIA_RESOLUTION_UNSPECIFIED",
        "MEDIA_RESOLUTION_LOW",
        "MEDIA_RESOLUTION_MEDIUM",
        "MEDIA_RESOLUTION_HIGH",
      ])
      .optional()
      .describe(`https://ai.google.dev/api/generate-content#MediaResolution`),
  })
  .describe(
    `https://ai.google.dev/api/generate-content#v1beta.GenerationConfig`,
  );

export const SystemInstructionSchema = z
  .object({
    parts: z.array(
      z.object({
        text: z.string(),
      }),
    ),
  })
  .describe("Developer set system instruction(s). Currently, text only.");

const CitationMetadataSchema = z
  .object({
    citationSources: z.array(
      z
        .object({
          startIndex: z.number().optional(),
          endIndex: z.number().optional(),
          uri: z.string().optional(),
          license: z.string().optional(),
        })
        .optional()
        .describe(`https://ai.google.dev/api/generate-content#CitationSource`),
    ),
  })
  .optional()
  .describe(`https://ai.google.dev/api/generate-content#citationmetadata`);

export const FinishReasonSchema = z
  .enum([
    "FINISH_REASON_UNSPECIFIED",
    "STOP",
    "MAX_TOKENS",
    "SAFETY",
    "RECITATION",
    "LANGUAGE",
    "OTHER",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "MALFORMED_FUNCTION_CALL",
    "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT",
    "IMAGE_OTHER",
    "NO_IMAGE",
    "IMAGE_RECITATION",
    "UNEXPECTED_TOOL_CALL",
    "TOO_MANY_TOOL_CALLS",
  ])
  .optional()
  .describe(`
  The reason why the model stopped generating tokens.

  If empty, the model has not stopped generating tokens.

  https://ai.google.dev/api/generate-content#FinishReason
`);

export const CandidateSchema = z
  .object({
    content: ContentSchema,
    finishReason: FinishReasonSchema,
    safetyRatings: z.array(SafetyRatingSchema).optional(),
    citationMetadata: CitationMetadataSchema.optional(),
    tokenCount: z.number().optional(),
    groundingAttributions: z.array(z.any()).optional(),
    groundingMetadata: z.any().optional(),
    avgLogprobs: z.number().optional(),
    logprobsResult: z.any().optional(),
    urlContextMetadata: z.any().optional(),
    index: z
      .number()
      .describe("Index of the candidate in the list of response candidates."),
    finishMessage: z
      .string()
      .optional()
      .describe(
        "Details the reason why the model stopped generating tokens. This is populated only when finishReason is set.",
      ),
  })
  .describe(`https://ai.google.dev/api/generate-content#candidate`);

const PromptFeedbackSchema = z
  .object({
    blockReason: z
      .enum([
        "BLOCK_REASON_UNSPECIFIED",
        "SAFETY",
        "OTHER",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "IMAGE_SAFETY",
      ])
      .optional()
      .describe(
        `Specifies the reason why the prompt was blocked. https://ai.google.dev/api/generate-content#BlockReason`,
      ),
    safetyRatings: z.array(SafetyRatingSchema),
  })
  .describe(`
  Returns the prompt's feedback related to the content filters.

https://ai.google.dev/api/generate-content#PromptFeedback
`);

const ModalityTokenCountSchema = z
  .object({
    modality: ModalitySchema,
    tokenCount: z.number().describe("Number of tokens"),
  })
  .describe(
    `https://ai.google.dev/api/generate-content#v1beta.ModalityTokenCount`,
  );

export const UsageMetadataSchema = z
  .object({
    promptTokenCount: z.number().optional(),
    cachedContentTokenCount: z.number().optional(),
    candidatesTokenCount: z.number().optional(),
    toolUsePromptTokenCount: z.number().optional(),
    thoughtsTokenCount: z.number().optional(),
    totalTokenCount: z.number().optional(),
    promptTokensDetails: z.array(ModalityTokenCountSchema).optional(),
    cacheTokensDetails: z.array(ModalityTokenCountSchema).optional(),
    candidatesTokensDetails: z.array(ModalityTokenCountSchema).optional(),
    toolUsePromptTokensDetails: z.array(ModalityTokenCountSchema).optional(),
  })
  .describe(`https://ai.google.dev/api/generate-content#UsageMetadata`);

export const GenerateContentRequestSchema = z
  .object({
    contents: z
      .array(ContentSchema)
      .describe(
        "The content of the current conversation with the model. For single-turn queries, this is a single instance. For multi-turn queries like chat, this is a repeated field that contains the conversation history and the latest request",
      ),
    tools: z
      .union([z.array(ToolSchema), ToolSchema])
      .optional()
      .describe(
        "A list of Tools the Model may use to generate the next response. A Tool is a piece of code that enables the system to interact with external systems to perform an action, or set of actions, outside of knowledge and scope of the Model. Supported Tools are Function and codeExecution. Refer to the Function calling and the Code execution guides to learn more.",
      ),
    toolConfig: ToolConfigSchema.optional().describe(
      "Tool configuration for any Tool specified in the request.",
    ),
    safetySettings: z
      .array(SafetySettingSchema)
      .optional()
      .describe(
        "A list of unique SafetySetting instances for blocking unsafe content.",
      ),
    systemInstruction: SystemInstructionSchema.optional(),
    generationConfig: GenerationConfigSchema.optional(),
    cachedContent: z
      .string()
      .optional()
      .describe(
        "The name of the content cached to use as context to serve the prediction. Format: cachedContents/{cachedContent}",
      ),

    config: z
      .object({
        tools: z.union([z.array(ToolSchema), ToolSchema]).optional(),
        toolConfig: ToolConfigSchema.optional().describe(
          "Tool configuration for any Tool specified in the request.",
        ),
      })
      .optional(),
  })
  .describe(`https://ai.google.dev/api/generate-content#request-body`);

export const GenerateContentResponseSchema = z
  .object({
    candidates: z
      .array(CandidateSchema)
      .describe("Candidate responses from the model"),
    promptFeedback: PromptFeedbackSchema.optional().describe(
      "Returns the prompt's feedback related to the content filters",
    ),
    usageMetadata: UsageMetadataSchema.optional().describe(
      "Metadata on the generation requests' token usage",
    ),
    modelVersion: z
      .string()
      .optional()
      .describe("The model version used to generate the response."),
    responseId: z.string().optional().describe("The unique response ID."),
  })
  .describe(`
Response from the model supporting multiple candidate responses.

https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse
`);

export const GenerateContentHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  "x-goog-api-key": z.string().describe("API key for Google Gemini"),
});
