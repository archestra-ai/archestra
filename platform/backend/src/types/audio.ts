import { z } from "zod";

export const AudioOperationSchema = z.enum([
  "speech",
  "transcriptions",
  "translations",
]);

export const AudioSpeechRequestSchema = z
  .object({
    model: z.string().min(1).max(512),
    input: z.string().min(1).max(4096),
    voice: z.union([
      z.string().min(1).max(512),
      z.object({ id: z.string().min(1).max(512) }),
    ]),
    instructions: z.string().max(16384).optional(),
    response_format: z
      .enum(["mp3", "opus", "aac", "flac", "wav", "pcm"])
      .optional(),
    speed: z.number().min(0.25).max(4).optional(),
    stream_format: z.enum(["audio", "sse"]).optional(),
  })
  .passthrough();

export const AudioUploadFieldsSchema = z
  .object({
    model: z.string().min(1).max(512),
    language: z.string().min(1).max(64).optional(),
    prompt: z.string().max(16384).optional(),
    response_format: z
      .enum(["json", "text", "srt", "verbose_json", "vtt", "diarized_json"])
      .optional(),
    temperature: z.number().min(0).max(1).optional(),
    stream: z.boolean().optional(),
    include: z.array(z.string().min(1).max(128)).max(16).optional(),
    timestamp_granularities: z
      .array(z.enum(["word", "segment"]))
      .max(2)
      .optional(),
    known_speaker_names: z.array(z.string().min(1).max(128)).max(4).optional(),
    known_speaker_references: z.array(z.string().min(1)).max(4).optional(),
    languages: z.array(z.string().min(1).max(64)).max(32).optional(),
    chunking_strategy: z
      .union([
        z.literal("auto"),
        z.object({
          type: z.literal("server_vad"),
          threshold: z.number().min(0).max(1).optional(),
          prefix_padding_ms: z.number().int().nonnegative().optional(),
          silence_duration_ms: z.number().int().positive().optional(),
        }),
      ])
      .optional(),
  })
  .passthrough();

// Multipart is validated by parseAudioUploadRequest after bounded byte parsing;
// Fastify's JSON validator sees no decoded multipart body. Describe its actual
// wire format here so generated clients send file uploads instead of JSON.
export const AudioMultipartBodySchema = z.unknown().meta({
  type: "object",
  properties: {
    ...z.toJSONSchema(AudioUploadFieldsSchema).properties,
    file: {
      type: "string",
      format: "binary",
      description: "Audio file (maximum 25 MiB)",
    },
  },
  required: ["model", "file"],
});

/** Only this metadata enters the common proxy/audit/plugin pipeline. */
export const AudioAuditRequestSchema = z.object({
  model: z.string(),
  operation: AudioOperationSchema,
  response_format: z.string().optional(),
  stream_format: z.string().optional(),
  input_characters: z.number().int().nonnegative().optional(),
  file: z
    .object({
      filename: z.string(),
      mimetype: z.string(),
      size: z.number().int().nonnegative(),
    })
    .optional(),
});

export const AudioAuditResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  operation: AudioOperationSchema,
  content_type: z.string(),
  bytes: z.number().int().nonnegative(),
  usage_available: z.boolean(),
  cost_available: z.literal(false),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export type AudioOperation = z.infer<typeof AudioOperationSchema>;
export type AudioAuditRequest = z.infer<typeof AudioAuditRequestSchema>;
export type AudioAuditResponse = z.infer<typeof AudioAuditResponseSchema>;
