import { RouteId } from "@archestra/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { ApiError, UuidIdSchema } from "@/types";
import {
  type AudioAuditRequest,
  AudioMultipartBodySchema,
  type AudioOperation,
  AudioSpeechRequestSchema,
  AudioUploadFieldsSchema,
} from "@/types/audio";
import { makeAudioAdapterFactory } from "../adapters/audio";
import { PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { getAzureProxyIngress } from "../utils/azure-ingress";
import {
  type MediaMultipartFile,
  parseMediaMultipart,
  registerMediaMultipartParser,
} from "../utils/media-multipart";

export {
  AudioMultipartBodySchema,
  AudioSpeechRequestSchema,
} from "@/types/audio";
export type AudioProxyBody = Record<string, unknown> & {
  model: string;
  file?: MediaMultipartFile;
};

export async function parseAudioUploadRequest(
  request: FastifyRequest,
  operation: "transcriptions" | "translations",
): Promise<AudioProxyBody> {
  const parsed = await parseMediaMultipart(request, {
    fileFields: ["file"],
    arrayFields: [
      "include",
      "timestamp_granularities",
      "known_speaker_names",
      "known_speaker_references",
      "languages",
    ],
    maxFiles: 1,
    maxFileBytes: Math.min(25 * 1024 * 1024, PROXY_BODY_LIMIT),
    maxTotalFileBytes: Math.min(25 * 1024 * 1024, PROXY_BODY_LIMIT),
    maxFields: 64,
    maxFieldBytes: Math.min(PROXY_BODY_LIMIT, 4 * 1024 * 1024),
    maxParts: 65,
  });
  const file = parsed.files[0];
  if (!file || file.data.length === 0)
    throw new ApiError(400, "A nonempty audio file is required");
  const extension = file.filename.split(".").at(-1)?.toLowerCase();
  if (
    !extension ||
    ![
      "flac",
      "mp3",
      "mp4",
      "mpeg",
      "mpga",
      "m4a",
      "ogg",
      "wav",
      "webm",
    ].includes(extension)
  )
    throw new ApiError(400, "Unsupported audio filename extension");
  if (
    !file.mimetype.startsWith("audio/") &&
    !["application/octet-stream", "video/mp4", "video/webm"].includes(
      file.mimetype,
    )
  )
    throw new ApiError(415, "Unsupported audio content type");
  if (
    extension === "wav" &&
    (file.data.toString("ascii", 0, 4) !== "RIFF" ||
      file.data.toString("ascii", 8, 12) !== "WAVE")
  )
    throw new ApiError(400, "Malformed WAV file");
  const fields: Record<string, unknown> = { ...parsed.fields };
  const deployment = getAzureProxyIngress(request)?.deployment;
  if (deployment) fields.model = deployment;
  if (fields.temperature !== undefined)
    fields.temperature = numericField(fields.temperature);
  if (fields.stream !== undefined) {
    if (fields.stream !== "true" && fields.stream !== "false")
      throw new ApiError(400, "Invalid audio stream parameter");
    fields.stream = fields.stream === "true";
  }
  const chunkingKeys = Object.keys(fields).filter((key) =>
    key.startsWith("chunking_strategy["),
  );
  if (chunkingKeys.length) {
    if (fields.chunking_strategy !== undefined)
      throw new ApiError(400, "Duplicate chunking strategy");
    const strategy: Record<string, unknown> = {};
    for (const key of chunkingKeys) {
      const name = key.slice("chunking_strategy[".length, -1);
      if (
        ![
          "type",
          "threshold",
          "prefix_padding_ms",
          "silence_duration_ms",
        ].includes(name) ||
        !key.endsWith("]")
      )
        throw new ApiError(400, "Invalid chunking strategy");
      strategy[name] =
        name === "type" ? fields[key] : numericField(fields[key]);
      delete fields[key];
    }
    fields.chunking_strategy = strategy;
  }
  const validated = AudioUploadFieldsSchema.safeParse(fields);
  if (!validated.success)
    throw new ApiError(400, "Invalid audio request parameters");
  if (
    operation === "translations" &&
    (validated.data.stream === true ||
      validated.data.response_format === "diarized_json")
  )
    throw new ApiError(400, "Unsupported translation response mode");
  return { ...validated.data, file };
}

/** Shared with the model router; credentials and budgets stay in handleLLMProxy. */
export function handleAudioProxy(params: {
  body: AudioProxyBody;
  request: FastifyRequest;
  reply: FastifyReply;
  provider: "azure" | "openai";
  operation: AudioOperation;
}) {
  const { body, request, reply, provider, operation } = params;
  const { file, ...parameters } = body;
  const safe: AudioAuditRequest = {
    model: body.model,
    operation,
    ...(typeof body.response_format === "string"
      ? { response_format: body.response_format }
      : {}),
    ...(typeof body.stream_format === "string"
      ? { stream_format: body.stream_format }
      : {}),
    ...(typeof body.input === "string"
      ? { input_characters: body.input.length }
      : {}),
    ...(file
      ? {
          file: {
            filename: file.filename,
            mimetype: file.mimetype,
            size: file.data.length,
          },
        }
      : {}),
  };
  request.body = safe;
  return handleLLMProxy(
    safe,
    request,
    reply,
    makeAudioAdapterFactory({ provider, operation, parameters, file }),
  );
}

export async function registerAudioRoutes(
  fastify: FastifyInstanceWithZod,
  provider: "azure" | "openai",
) {
  await registerMediaMultipartParser(fastify);
  for (const operation of [
    "speech",
    "transcriptions",
    "translations",
  ] as const) {
    for (const withAgent of [false, true]) {
      fastify.post(
        `/v1/${provider}${withAgent ? "/:agentId" : ""}/audio/${operation}`,
        {
          bodyLimit: PROXY_BODY_LIMIT,
          schema: {
            operationId:
              AUDIO_ROUTE_IDS[provider][operation][withAgent ? 1 : 0],
            description:
              operation === "speech"
                ? "Generate native audio bytes or audio SSE through the governed proxy. Usage and audio pricing may be unavailable."
                : "Upload multipart audio with file and model fields. Returns the provider's native transcript bytes or supported SSE. Raw audio is never retained in interaction logs.",
            tags: ["LLM Proxy"],
            ...(withAgent
              ? { params: z.object({ agentId: UuidIdSchema }) }
              : {}),
            ...(operation === "speech"
              ? { body: AudioSpeechRequestSchema }
              : {
                  consumes: ["multipart/form-data"],
                  body: AudioMultipartBodySchema,
                }),
          },
        },
        async (request, reply) => {
          const body =
            operation === "speech"
              ? (request.body as AudioProxyBody)
              : await parseAudioUploadRequest(request, operation);
          return handleAudioProxy({
            body,
            request,
            reply,
            provider,
            operation,
          });
        },
      );
    }
  }
}

function numericField(value: unknown): number {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    !Number.isFinite(Number(value))
  )
    throw new ApiError(400, "Invalid numeric audio parameter");
  return Number(value);
}

const AUDIO_ROUTE_IDS = {
  azure: {
    speech: [
      RouteId.AzureAudioSpeechWithDefaultAgent,
      RouteId.AzureAudioSpeechWithAgent,
    ],
    transcriptions: [
      RouteId.AzureAudioTranscriptionsWithDefaultAgent,
      RouteId.AzureAudioTranscriptionsWithAgent,
    ],
    translations: [
      RouteId.AzureAudioTranslationsWithDefaultAgent,
      RouteId.AzureAudioTranslationsWithAgent,
    ],
  },
  openai: {
    speech: [
      RouteId.OpenAiAudioSpeechWithDefaultAgent,
      RouteId.OpenAiAudioSpeechWithAgent,
    ],
    transcriptions: [
      RouteId.OpenAiAudioTranscriptionsWithDefaultAgent,
      RouteId.OpenAiAudioTranscriptionsWithAgent,
    ],
    translations: [
      RouteId.OpenAiAudioTranslationsWithDefaultAgent,
      RouteId.OpenAiAudioTranslationsWithAgent,
    ],
  },
} as const;
