import { randomUUID } from "node:crypto";
import {
  ArchestraInternalErrorCode,
  type ModelInputModality,
  type ModelOutputModality,
} from "@archestra/shared";
import { z } from "zod";
import config from "@/config";
import { decodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { createOpenAiCodexFetch } from "@/services/openai-codex-token";
import { ApiError, type OpenAi } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchLiteLlmMetadata, readOutputTokenLimit } from "./litellm";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import {
  type FetchedModelCapabilities,
  type ModelFetchOptions,
  type ModelInfo,
  modelFetchError,
} from "./types";

// Codex uses client_version to gate models that require a newer client.
// An hourly workflow proposes updates from stable Codex CLI releases.
const CODEX_MODELS_CLIENT_VERSION = "0.166.0";

const CodexModelsResponseSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string().optional(),
      visibility: z.enum(["list", "hide", "none"]),
      priority: z.number(),
    }),
  ),
});

export function mapOpenAiModelToModelInfo(
  model: (OpenAi.Types.Model | OpenAi.Types.OrlandoModel) & {
    max_output_tokens?: unknown;
  },
): ModelInfo {
  let provider: ModelInfo["provider"] = "openai";

  if (!("owned_by" in model)) {
    if (model.id.startsWith("claude-")) {
      provider = "anthropic";
    } else if (model.id.startsWith("gemini-")) {
      provider = "gemini";
    }
  }
  const outputLength = readOutputTokenLimit(model.max_output_tokens);

  return {
    id: model.id,
    displayName: "name" in model ? model.name : model.id,
    provider,
    createdAt:
      "created" in model
        ? new Date(model.created * 1000).toISOString()
        : undefined,
    ...(outputLength !== undefined ? { capabilities: { outputLength } } : {}),
  };
}

// babbage/davinci are OpenAI's legacy completions-only base models: they 404 on
// /chat/completions ("not a chat model"). They, and the other non-chat families
// that no governed endpoint serves, are dropped from sync: live voice models
// speak only the Realtime transcription API, moderation models only
// /moderations. Image, speech, transcription and realtime models are kept as
// media models (openAiMediaCapabilities).
const NON_CHAT_MODEL_ID_PATTERNS = [
  "instruct",
  "realtime",
  "gpt-live",
  "moderation",
  "tts",
  "whisper",
  "image",
  "audio",
  "sora",
  "dall-e",
  "babbage",
  "davinci",
];

/** The chat-catalog name filter; the OpenAI proxy `/models` listing applies it too. */
export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_MODEL_ID_PATTERNS.some((pattern) => lower.includes(pattern));
}

export async function fetchOpenAiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
  opts?: ModelFetchOptions,
): Promise<ModelInfo[]> {
  // ChatGPT subscription credentials use the account's Codex model catalog.
  const codexCredential = decodeOpenAiCodexCredential(apiKey);
  if (codexCredential) {
    // The wrapper redeems and rotates the OAuth token, then retries one 401.
    // Passing the key row id preserves a rotated refresh token during sync.
    const codexFetch = createOpenAiCodexFetch({
      credential: codexCredential,
      providerApiKeyId: opts?.providerApiKeyId,
      sessionId: randomUUID(),
    });
    const url = joinBaseUrl(
      config.llm.openai.codex.apiBaseUrl,
      `/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`,
    );
    const response = await codexFetch(url, { redirect: "error" });
    if (response.status === 401) {
      throw new ApiError(
        401,
        "ChatGPT sign-in has expired or been revoked. Reconnect your ChatGPT account to keep using your Codex subscription.",
        ArchestraInternalErrorCode.ProviderAuthRequired,
      );
    }
    if (!response.ok) {
      throw modelFetchError("OpenAI Codex models", response.status);
    }

    const { models } = CodexModelsResponseSchema.parse(await response.json());
    return models
      .filter((model) => model.visibility === "list")
      .sort((a, b) => a.priority - b.priority)
      .map((model) => ({
        id: model.slug,
        displayName: model.display_name || model.slug,
        provider: "openai" as const,
      }));
  }

  const baseUrl = baseUrlOverride || config.llm.openai.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    data: ((OpenAi.Types.Model | OpenAi.Types.OrlandoModel) & {
      max_output_tokens?: unknown;
    })[];
  }>({
    url: joinBaseUrl(baseUrl, "/models"),
    apiKey,
    errorLabel: "OpenAI models",
    extraHeaders,
  });

  const { prices, outputLimits } = await fetchLiteLlmMetadata({
    baseUrl,
    apiKey,
    extraHeaders,
  });
  return data.data.flatMap((model) => {
    // Classification wins over the chat-name filter: transcription ids pass
    // it, audio chat ids fail it.
    const classified =
      openAiMediaCapabilities(model.id) ??
      openAiAudioChatCapabilities(model.id);
    if (!classified && !isChatModelId(model.id)) {
      return [];
    }
    const mapped = mapOpenAiModelToModelInfo(model);
    const limits = [
      mapped.capabilities?.outputLength,
      outputLimits.get(model.id),
    ].filter((limit): limit is number => typeof limit === "number");
    const capabilities: FetchedModelCapabilities = {
      ...(classified ?? openAiSearchCapabilities(model.id)),
      ...(limits.length ? { outputLength: Math.min(...limits) } : {}),
    };
    return [
      {
        ...mapped,
        ...(Object.keys(capabilities).length ? { capabilities } : {}),
        ...(prices.has(model.id)
          ? { providerPricing: prices.get(model.id) }
          : {}),
      },
    ];
  });
}

/**
 * Media models the governed image and audio endpoints serve. Sync keeps them
 * with their real modalities so the Model Router can resolve them, while a
 * non-text output (or audio-only input) keeps them out of chat pickers
 * (`ModelModel.supportsTextChat`).
 */
function openAiMediaCapabilities(id: string): FetchedModelCapabilities | null {
  const lower = id.toLowerCase();
  if (/^(gpt-image-|chatgpt-image-|dall-e-)/.test(lower)) {
    return mediaCapabilities(["text"], ["image"]);
  }
  // The generation segment is optional: OpenAI also ships bare `gpt-transcribe`.
  if (/^(tts-|gpt-(?:[\w.-]+-)?tts(?:-|$))/.test(lower)) {
    return mediaCapabilities(["text"], ["audio"]);
  }
  if (/^(whisper-|gpt-(?:[\w.-]+-)?transcribe(?:-|$))/.test(lower)) {
    return mediaCapabilities(["audio"], ["text"]);
  }
  // Realtime models speak only the Realtime API, which the Model Router
  // serves over WebSocket; their audio output keeps them out of chat.
  if (/^gpt-realtime(?:-|$)/.test(lower)) {
    return mediaCapabilities(["text", "audio"], ["audio"]);
  }
  return null;
}

/**
 * Audio chat models (`gpt-audio`, `gpt-audio-mini` and the `*-audio-preview`
 * snapshots) answer `/chat/completions` with text, or with speech when the
 * request asks for the audio modality, and call tools like any chat model.
 * Both modalities are recorded so chat pickers and the Model Router keep them.
 */
function openAiAudioChatCapabilities(
  id: string,
): FetchedModelCapabilities | null {
  return /^gpt-audio(?:-|$)|audio-preview/.test(id.toLowerCase())
    ? {
        inputModalities: ["text", "audio"],
        outputModalities: ["text", "audio"],
        supportsToolCalling: true,
        authoritative: true,
      }
    : null;
}

/**
 * Search models answer chat turns but reject function tools ("tools is not
 * supported in this model"), so chat sends them none.
 */
function openAiSearchCapabilities(id: string): FetchedModelCapabilities | null {
  return /-search-(?:preview|api)(?:-|$)/i.test(id)
    ? { supportsToolCalling: false, authoritative: true }
    : null;
}

function mediaCapabilities(
  inputModalities: ModelInputModality[],
  outputModalities: ModelOutputModality[],
): FetchedModelCapabilities {
  return {
    inputModalities,
    outputModalities,
    supportsToolCalling: false,
    authoritative: true,
  };
}
