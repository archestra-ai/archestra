/**
 * Costs for media operations the per-token chat tariff cannot express: image
 * tokens priced apart from text tokens, speech billed per input character, and
 * transcription billed per minute of audio.
 *
 * Each figure is transcribed from the vendor's own price list, as in
 * `vendor-published-pricing.ts`, and each formula follows what the vendor
 * meters on the response:
 *
 * - OpenAI: https://developers.openai.com/api/docs/pricing (standard tier).
 *   `gpt-image-1` no longer appears there; its figures are the ones it was
 *   published at.
 * - Google: https://ai.google.dev/gemini-api/docs/pricing (paid tier).
 *
 * All rates are USD per million tokens or characters, or per minute of audio.
 * A model or response the tables cannot price returns `undefined`: an unknown
 * cost is reported as unknown, never as zero.
 */

import type { MediaPricing } from "@/types";

export type MediaOperation =
  | "image-generation"
  | "image-edit"
  | "audio-speech"
  | "audio-transcription"
  | "audio-translation"
  | "realtime";

/** Whether a request of this shape can be priced once its response arrives. */
export function mediaTariffCovers(params: {
  provider: string;
  model: string;
  operation: MediaOperation;
  /** Speech: whether the response streams usage (`stream_format: "sse"`). */
  streamsUsage?: boolean;
  /** Transcription: the requested response format. */
  responseFormat?: string;
  /** Transcription and translation: the uploaded audio's measured duration. */
  audioSeconds?: number;
}): boolean {
  const { provider, model, operation } = params;
  switch (operation) {
    case "image-generation":
    case "image-edit":
      return provider === "gemini"
        ? lookup(GEMINI_IMAGE, model) !== undefined
        : lookup(OPENAI_IMAGE, model) !== undefined;
    case "audio-speech": {
      const tariff = lookup(OPENAI_SPEECH, model);
      return (
        tariff !== undefined &&
        ("perMillionCharacters" in tariff || params.streamsUsage === true)
      );
    }
    case "audio-transcription": {
      const tariff = lookup(OPENAI_TRANSCRIPTION, model);
      // Only the JSON formats and the stream carry the usage that is billed;
      // any other format is priced from the upload's measured duration.
      const format = params.responseFormat ?? "json";
      return (
        tariff !== undefined &&
        (format === "json" ||
          format === "verbose_json" ||
          params.audioSeconds !== undefined)
      );
    }
    case "audio-translation":
      // Translations report neither tokens nor duration, so only a measured
      // upload prices them.
      return (
        lookup(OPENAI_TRANSCRIPTION, model) !== undefined &&
        params.audioSeconds !== undefined
      );
    case "realtime":
      return lookup(OPENAI_REALTIME, model) !== undefined;
  }
}

/** OpenAI Images usage, as the Images API reports it. */
interface OpenAiImageUsage {
  input_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

/**
 * Cost of an OpenAI or Azure OpenAI image generation or edit. Input text and
 * image tokens and output image and text tokens are each priced at their own
 * rate. Without a breakdown, input counts as text and output as image tokens,
 * which is what a generation from a prompt consumes.
 */
export function priceOpenAiImage(params: {
  model: string;
  usage: OpenAiImageUsage | undefined;
}): number | undefined {
  const tariff = lookup(OPENAI_IMAGE, params.model);
  const usage = params.usage;
  if (!tariff || !usage || typeof usage.input_tokens !== "number") return;
  if (typeof usage.output_tokens !== "number") return;
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
  const textIn = usage.input_tokens_details
    ? (usage.input_tokens_details.text_tokens ?? 0)
    : usage.input_tokens;
  const textOut = usage.output_tokens_details?.text_tokens ?? 0;
  const imageOut = usage.output_tokens_details
    ? (usage.output_tokens_details.image_tokens ?? 0)
    : usage.output_tokens;
  return perMillion(
    textIn * tariff.textInput +
      imageIn * tariff.imageInput +
      imageOut * tariff.imageOutput +
      textOut * (tariff.textOutput ?? 0),
  );
}

/** Gemini `usageMetadata`, as generateContent reports it. */
interface GeminiImageUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

/**
 * Cost of a Gemini image generation or edit. Text and image input share one
 * rate; generated images and text (thinking included) are priced apart. With
 * no modality breakdown every candidate token counts as image output.
 */
export function priceGeminiImage(params: {
  model: string;
  usage: GeminiImageUsage | undefined;
}): number | undefined {
  const tariff = lookup(GEMINI_IMAGE, params.model);
  const usage = params.usage;
  if (!tariff || !usage || typeof usage.promptTokenCount !== "number") return;
  if (typeof usage.candidatesTokenCount !== "number") return;
  const details = usage.candidatesTokensDetails;
  const imageOut = details
    ? sumTokens(details, (modality) => modality === "IMAGE")
    : usage.candidatesTokenCount;
  const textOut =
    (details ? sumTokens(details, (modality) => modality !== "IMAGE") : 0) +
    (usage.thoughtsTokenCount ?? 0);
  return perMillion(
    usage.promptTokenCount * tariff.input +
      imageOut * tariff.imageOutput +
      textOut * tariff.textOutput,
  );
}

/**
 * Cost of an OpenAI or Azure OpenAI audio call. Speech is billed per input
 * character, or by text input and audio output tokens for token-priced voices;
 * transcription and translation per minute of audio or by input and output
 * tokens, whichever the model is metered by and the response reports.
 *
 * A response without usage (text, SRT and VTT transcripts, translations) is
 * priced from the upload's measured duration, rounded up to the whole second
 * as OpenAI rounds the `seconds` it reports. A token-metered model is then
 * priced at the per-minute estimate OpenAI publishes beside its token rates.
 */
export function priceOpenAiAudio(params: {
  model: string;
  operation: MediaOperation;
  /** Speech input text. */
  input?: string;
  /** The `usage` object of the response or of its final stream event. */
  usage?: Record<string, unknown>;
  /** Transcription and translation: the uploaded audio's measured duration. */
  audioSeconds?: number;
}): number | undefined {
  const { model, operation, usage } = params;
  if (operation === "audio-speech") {
    const tariff = lookup(OPENAI_SPEECH, model);
    if (!tariff) return;
    if ("perMillionCharacters" in tariff) {
      if (typeof params.input !== "string") return;
      return perMillion([...params.input].length * tariff.perMillionCharacters);
    }
    const input = numberField(usage, "input_tokens");
    const output = numberField(usage, "output_tokens");
    if (input === undefined || output === undefined) return;
    return perMillion(input * tariff.textInput + output * tariff.audioOutput);
  }
  if (
    operation === "audio-transcription" ||
    operation === "audio-translation"
  ) {
    const tariff = lookup(OPENAI_TRANSCRIPTION, model);
    if (!tariff) return;
    const measured =
      params.audioSeconds === undefined
        ? undefined
        : Math.ceil(params.audioSeconds - 1e-6);
    if ("perMinute" in tariff) {
      const seconds = numberField(usage, "seconds") ?? measured;
      return seconds === undefined
        ? undefined
        : perMinute(seconds, tariff.perMinute);
    }
    const input = numberField(usage, "input_tokens");
    const output = numberField(usage, "output_tokens");
    if (input !== undefined && output !== undefined)
      return perMillion(input * tariff.input + output * tariff.output);
    return measured === undefined
      ? undefined
      : perMinute(measured, tariff.estimatedPerMinute);
  }
  return undefined;
}

/** Chat Completions usage, as OpenAI reports it for an audio chat model. */
interface OpenAiChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    audio_tokens?: number;
    text_tokens?: number;
  } | null;
  completion_tokens_details?: {
    audio_tokens?: number;
    text_tokens?: number;
  } | null;
}

/**
 * Cost of an OpenAI audio chat response (`gpt-audio`): the audio tokens
 * inside the prompt and completion counts are priced at the audio rates, the
 * rest at the model's text rates. A response without audio tokens is left to
 * the per-token chat price, so `undefined` means "not an audio response"
 * as well as "not priced here".
 */
export function priceOpenAiAudioChat(params: {
  model: string;
  usage: OpenAiChatUsage | undefined;
}): number | undefined {
  const tariff = lookup(OPENAI_AUDIO_CHAT, params.model);
  const usage = params.usage;
  if (!tariff || !usage) return;
  const audioIn = usage.prompt_tokens_details?.audio_tokens ?? 0;
  const audioOut = usage.completion_tokens_details?.audio_tokens ?? 0;
  if (audioIn + audioOut === 0) return;
  const textIn = Math.max(0, (usage.prompt_tokens ?? 0) - audioIn);
  const textOut = Math.max(0, (usage.completion_tokens ?? 0) - audioOut);
  return perMillion(
    textIn * tariff.textInput +
      audioIn * tariff.audioInput +
      textOut * tariff.textOutput +
      audioOut * tariff.audioOutput,
  );
}

/** The `usage` of a Realtime `response.done` event. */
interface OpenAiRealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: {
      text_tokens?: number;
      audio_tokens?: number;
      image_tokens?: number;
    };
  } | null;
  output_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
  } | null;
}

/**
 * Cost of one Realtime response: text, audio and image input tokens at their
 * own rates, cached input at the cached rates, text and audio output apart.
 * Cached tokens are a subset of the input tokens OpenAI reports.
 */
export function priceOpenAiRealtime(params: {
  model: string;
  usage: OpenAiRealtimeUsage | undefined;
}): number | undefined {
  const tariff = lookup(OPENAI_REALTIME, params.model);
  const usage = params.usage;
  if (!tariff || !usage || typeof usage.input_tokens !== "number") return;
  if (typeof usage.output_tokens !== "number") return;
  const input = usage.input_token_details;
  const cached = input?.cached_tokens_details;
  const cachedText = cached?.text_tokens ?? 0;
  const cachedAudio = cached?.audio_tokens ?? 0;
  const cachedImage = cached?.image_tokens ?? 0;
  // Without a modality breakdown every input token counts as text.
  const textIn = (input?.text_tokens ?? usage.input_tokens) - cachedText;
  const audioIn = (input?.audio_tokens ?? 0) - cachedAudio;
  const imageIn = (input?.image_tokens ?? 0) - cachedImage;
  const output = usage.output_token_details;
  const audioOut = output?.audio_tokens ?? 0;
  const textOut = output?.text_tokens ?? usage.output_tokens - audioOut;
  return perMillion(
    Math.max(0, textIn) * tariff.textInput +
      Math.max(0, audioIn) * tariff.audioInput +
      Math.max(0, imageIn) * tariff.imageInput +
      cachedText * tariff.cachedTextInput +
      cachedAudio * tariff.cachedAudioInput +
      cachedImage * tariff.cachedImageInput +
      Math.max(0, textOut) * tariff.textOutput +
      audioOut * tariff.audioOutput,
  );
}

/**
 * A model's media rates as its vendor publishes them, for display beside the
 * per-token prices of chat models; `null` for a model these tables do not
 * price. The rates are the ones the proxy charges media calls by.
 */
export function mediaPricingFor(
  provider: string,
  model: string,
): MediaPricing | null {
  if (provider === "gemini") {
    const tariff = lookup(GEMINI_IMAGE, model);
    return tariff
      ? {
          per: "million_tokens",
          input: [{ kind: "text_and_image", usd: tariff.input }],
          output: [
            { kind: "image", usd: tariff.imageOutput },
            { kind: "text", usd: tariff.textOutput },
          ],
        }
      : null;
  }
  if (provider !== "openai" && provider !== "azure") return null;
  const image = lookup(OPENAI_IMAGE, model);
  if (image)
    return {
      per: "million_tokens",
      input: [
        { kind: "text", usd: image.textInput },
        { kind: "image", usd: image.imageInput },
      ],
      output: [
        { kind: "image", usd: image.imageOutput },
        ...(image.textOutput === undefined
          ? []
          : [{ kind: "text" as const, usd: image.textOutput }]),
      ],
    };
  const realtime = lookup(OPENAI_REALTIME, model);
  if (realtime)
    return {
      per: "million_tokens",
      input: [
        { kind: "text", usd: realtime.textInput },
        { kind: "audio", usd: realtime.audioInput },
        { kind: "image", usd: realtime.imageInput },
      ],
      output: [
        { kind: "text", usd: realtime.textOutput },
        { kind: "audio", usd: realtime.audioOutput },
      ],
    };
  const audioChat = lookup(OPENAI_AUDIO_CHAT, model);
  if (audioChat)
    return {
      per: "million_tokens",
      input: [
        { kind: "text", usd: audioChat.textInput },
        { kind: "audio", usd: audioChat.audioInput },
      ],
      output: [
        { kind: "text", usd: audioChat.textOutput },
        { kind: "audio", usd: audioChat.audioOutput },
      ],
    };
  const speech = lookup(OPENAI_SPEECH, model);
  if (speech)
    return "perMillionCharacters" in speech
      ? {
          per: "million_characters",
          input: [{ kind: "text", usd: speech.perMillionCharacters }],
          output: [],
        }
      : {
          per: "million_tokens",
          input: [{ kind: "text", usd: speech.textInput }],
          output: [{ kind: "audio", usd: speech.audioOutput }],
        };
  const transcription = lookup(OPENAI_TRANSCRIPTION, model);
  if (transcription)
    return "perMinute" in transcription
      ? {
          per: "minute",
          input: [{ kind: "audio", usd: transcription.perMinute }],
          output: [],
        }
      : {
          per: "million_tokens",
          input: [{ kind: "audio", usd: transcription.input }],
          output: [{ kind: "text", usd: transcription.output }],
        };
  return null;
}

// =============================================================================
// Tariffs and helpers
// =============================================================================

interface ImageTariff {
  textInput: number;
  imageInput: number;
  imageOutput: number;
  textOutput?: number;
}

const OPENAI_IMAGE: Record<string, ImageTariff> = {
  "gpt-image-1": { textInput: 5, imageInput: 10, imageOutput: 40 },
  "gpt-image-1-mini": { textInput: 2, imageInput: 2.5, imageOutput: 8 },
  "gpt-image-1.5": {
    textInput: 5,
    imageInput: 8,
    imageOutput: 32,
    textOutput: 10,
  },
  "gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "gpt-image-2.5-flare": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "gpt-image-2.5-sunburst": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "chatgpt-image-latest": {
    textInput: 5,
    imageInput: 8,
    imageOutput: 32,
    textOutput: 10,
  },
};

const GEMINI_IMAGE: Record<
  string,
  { input: number; textOutput: number; imageOutput: number }
> = {
  "gemini-2.5-flash-image": { input: 0.3, textOutput: 2.5, imageOutput: 30 },
  "gemini-3-pro-image": { input: 2, textOutput: 12, imageOutput: 120 },
  "gemini-3.1-flash-image": { input: 0.5, textOutput: 3, imageOutput: 60 },
  "gemini-3.1-flash-lite-image": {
    input: 0.25,
    textOutput: 1.5,
    imageOutput: 30,
  },
  "gemini-nano-banana-2.1": { input: 1.5, textOutput: 7.5, imageOutput: 30 },
};

/**
 * Realtime models: every input modality and cached input at its own rate.
 * `gpt-realtime-translate` and `gpt-realtime-whisper` are billed per minute
 * of a live session, which no response event reports, so they are not priced.
 */
const OPENAI_REALTIME: Record<
  string,
  {
    textInput: number;
    audioInput: number;
    imageInput: number;
    cachedTextInput: number;
    cachedAudioInput: number;
    cachedImageInput: number;
    textOutput: number;
    audioOutput: number;
  }
> = {
  "gpt-realtime": {
    textInput: 4,
    audioInput: 32,
    imageInput: 5,
    cachedTextInput: 0.4,
    cachedAudioInput: 0.4,
    cachedImageInput: 0.5,
    textOutput: 16,
    audioOutput: 64,
  },
  "gpt-realtime-mini": {
    textInput: 0.6,
    audioInput: 10,
    imageInput: 0.8,
    cachedTextInput: 0.06,
    cachedAudioInput: 0.3,
    cachedImageInput: 0.08,
    textOutput: 2.4,
    audioOutput: 20,
  },
  "gpt-realtime-1.5": {
    textInput: 4,
    audioInput: 32,
    imageInput: 5,
    cachedTextInput: 0.4,
    cachedAudioInput: 0.4,
    cachedImageInput: 0.5,
    textOutput: 16,
    audioOutput: 64,
  },
  "gpt-realtime-2": {
    textInput: 4,
    audioInput: 32,
    imageInput: 5,
    cachedTextInput: 0.4,
    cachedAudioInput: 0.4,
    cachedImageInput: 0.5,
    textOutput: 24,
    audioOutput: 64,
  },
  "gpt-realtime-2.1": {
    textInput: 4,
    audioInput: 32,
    imageInput: 5,
    cachedTextInput: 0.4,
    cachedAudioInput: 0.4,
    cachedImageInput: 0.5,
    textOutput: 24,
    audioOutput: 64,
  },
  "gpt-realtime-2.1-mini": {
    textInput: 0.6,
    audioInput: 10,
    imageInput: 0.8,
    cachedTextInput: 0.06,
    cachedAudioInput: 0.3,
    cachedImageInput: 0.08,
    textOutput: 2.4,
    audioOutput: 20,
  },
};

/** Audio chat models: text and audio tokens on both sides, priced apart. */
const OPENAI_AUDIO_CHAT: Record<
  string,
  {
    textInput: number;
    textOutput: number;
    audioInput: number;
    audioOutput: number;
  }
> = {
  "gpt-audio": {
    textInput: 2.5,
    textOutput: 10,
    audioInput: 32,
    audioOutput: 64,
  },
  "gpt-audio-1.5": {
    textInput: 2.5,
    textOutput: 10,
    audioInput: 32,
    audioOutput: 64,
  },
  "gpt-audio-mini": {
    textInput: 0.6,
    textOutput: 2.4,
    audioInput: 10,
    audioOutput: 20,
  },
};

const OPENAI_SPEECH: Record<
  string,
  { perMillionCharacters: number } | { textInput: number; audioOutput: number }
> = {
  "tts-1": { perMillionCharacters: 15 },
  "tts-1-hd": { perMillionCharacters: 30 },
  "gpt-4o-mini-tts": { textInput: 0.6, audioOutput: 12 },
};

/**
 * `estimatedPerMinute` is the "Estimated cost" OpenAI lists beside a
 * token-metered model's rates, used only when a response reports no tokens.
 */
const OPENAI_TRANSCRIPTION: Record<
  string,
  | { perMinute: number }
  | { input: number; output: number; estimatedPerMinute: number }
> = {
  "whisper-1": { perMinute: 0.006 },
  "gpt-transcribe": { perMinute: 0.0045 },
  "gpt-4o-transcribe": { input: 2.5, output: 10, estimatedPerMinute: 0.006 },
  "gpt-4o-transcribe-diarize": {
    input: 2.5,
    output: 10,
    estimatedPerMinute: 0.006,
  },
  "gpt-4o-mini-transcribe": {
    input: 1.25,
    output: 5,
    estimatedPerMinute: 0.003,
  },
};

/**
 * A tariff by model id. Dated snapshots (`gpt-image-2-2026-04-21`,
 * `tts-1-1106`), revisions (`gemini-2.5-flash-image-001`) and preview ids
 * (`gemini-3-pro-image-preview`) bill as the model they snapshot, and a
 * provider prefix (`google/…`) is ignored.
 */
function lookup<T>(table: Record<string, T>, model: string): T | undefined {
  const id = model.split("/").at(-1)?.toLowerCase() ?? "";
  const base = id
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{3,4})$/, "")
    .replace(/-preview(?:-\d{2}-\d{4})?$/, "");
  return Object.hasOwn(table, id)
    ? table[id]
    : Object.hasOwn(table, base)
      ? table[base]
      : undefined;
}

function perMillion(units: number): number {
  return Number((units / 1_000_000).toFixed(10));
}

function perMinute(seconds: number, rate: number): number {
  return Number(((seconds / 60) * rate).toFixed(10));
}

function sumTokens(
  details: Array<{ modality?: string; tokenCount?: number }>,
  include: (modality: string | undefined) => boolean,
): number {
  return details.reduce(
    (sum, item) => sum + (include(item.modality) ? (item.tokenCount ?? 0) : 0),
    0,
  );
}

function numberField(
  record: Record<string, unknown> | undefined,
  name: string,
): number | undefined {
  const value = record?.[name];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
