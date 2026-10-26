export type AzureModelKind =
  | "text"
  | "image"
  | "audio"
  | "realtime"
  | "translation"
  | "embedding";

export type AzureModelOperation =
  | "chat"
  | "responses"
  | "image-generation"
  | "image-edit"
  | "audio-speech"
  | "audio-transcription"
  | "audio-translation"
  | "realtime-turn"
  | "embedding";

export type AzureModelEvidence = {
  kind: AzureModelKind;
  underlyingModelName: string | null;
  operations: AzureModelOperation[];
  source: "deployment" | "catalog";
  /** Resolved during this resource's sync, before globally shared model rows merge. */
  inputModalities?: ModelInputModality[] | null;
  outputModalities?: ModelOutputModality[] | null;
  supportsToolCalling?: boolean | null;
};

/** Only canonical provider-reported backing names may be passed here. */
export function getAzureModelKind(underlyingModelName: string): AzureModelKind {
  const name = underlyingModelName.toLowerCase();
  if (name.startsWith("text-embedding-")) return "embedding";
  if (name.startsWith("gpt-image-") || /^dall-e-[23]$/.test(name))
    return "image";
  if (name.startsWith("gpt-realtime-translate")) return "translation";
  if (name.startsWith("gpt-realtime-") || name === "gpt-realtime")
    return "realtime";
  if (name === "gpt-audio" || name.startsWith("gpt-audio-")) return "audio";
  if (name.includes("realtime-preview")) return "realtime";
  if (name.includes("audio-preview")) return "audio";
  if (/^(tts-|whisper-|gpt-.*(?:tts|transcribe))/.test(name)) return "audio";
  return "text";
}

/** Missing backing identity never falls back to a deployment alias. */
export function azureModelEvidence(params: {
  underlyingModelName?: string | null;
  source: AzureModelEvidence["source"];
  capabilities?: Record<string, unknown>;
}): AzureModelEvidence | null {
  const name = params.underlyingModelName?.trim();
  const flags = params.capabilities;
  const enabled = (key: string) =>
    flags?.[key] === true || flags?.[key] === "true";
  const kind = enabled("image_generation")
    ? "image"
    : enabled("embeddings")
      ? "embedding"
      : name
        ? getAzureModelKind(name)
        : enabled("chat_completion")
          ? "text"
          : null;
  if (!kind) return null;
  if (
    kind === "text" &&
    !enabled("chat_completion") &&
    !/^(?:gpt-|o[134](?:-|$)|deepseek|phi-|llama|meta-|mistral|ministral|codestral|grok-|kimi-|qwen|mai-)/i.test(
      name ?? "",
    )
  )
    return null;
  let operations: AzureModelOperation[];
  switch (kind) {
    case "image":
      operations =
        name?.toLowerCase().startsWith("gpt-image-") ||
        name?.toLowerCase() === "dall-e-2" ||
        enabled("image_edit")
          ? ["image-generation", "image-edit"]
          : ["image-generation"];
      break;
    case "audio":
      operations = /^whisper-/i.test(name ?? "")
        ? ["audio-transcription", "audio-translation"]
        : /(?:^tts-|tts)/i.test(name ?? "")
          ? ["audio-speech"]
          : /transcribe/i.test(name ?? "")
            ? ["audio-transcription"]
            : ["chat"];
      break;
    case "realtime":
    case "translation":
      operations = ["realtime-turn"];
      break;
    case "embedding":
      operations = ["embedding"];
      break;
    default:
      operations = ["chat", "responses"];
  }
  const operationFlags: Partial<Record<AzureModelOperation, string>> = {
    chat: "chat_completion",
    responses: "responses",
    "image-generation": "image_generation",
    "image-edit": "image_edit",
    embedding: "embeddings",
  };
  operations = operations.filter((operation) => {
    const flag = operationFlags[operation];
    return !flag || (flags?.[flag] !== false && flags?.[flag] !== "false");
  });
  return {
    kind,
    underlyingModelName: name ?? null,
    operations,
    source: params.source,
  };
}

import type { ModelInputModality, ModelOutputModality } from "./chat";
