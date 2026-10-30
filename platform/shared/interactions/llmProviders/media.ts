import type { PartialUIMessage } from "../types";

type Part = PartialUIMessage["parts"][number];

/**
 * Media a log row kept (an image a model drew, audio it spoke or was sent),
 * as a part the conversation view plays or shows inline. The caption is one
 * grey line under the media: what it is, its format and size.
 */
export function inlineMediaPart(params: {
  mediaType: string;
  data: string;
  caption?: string;
}): Part {
  return {
    type: "file",
    mediaType: params.mediaType,
    url: `data:${params.mediaType};base64,${params.data}`,
    ...(params.caption ? { filename: params.caption } : {}),
  };
}

/** Media the provider returned as a link instead of bytes. */
export function linkedMediaPart(params: {
  mediaType: string;
  url: string;
  caption?: string;
}): Part {
  return {
    type: "file",
    mediaType: params.mediaType,
    url: params.url,
    ...(params.caption ? { filename: params.caption } : {}),
  };
}

/** Media the call carried that the log did not keep: what it was, and why. */
export function missingMediaPart(params: {
  kind: "audio" | "image";
  label: string;
  reason: string;
}): Part {
  return { type: "data-missing-media", data: params } as Part;
}

/** Why the log holds no copy of a clip: too large, or not kept at all. */
export function missingAudioReason(omitted: unknown): string {
  return omitted === "too_large"
    ? "Longer than the log keeps (2 MB per clip)"
    : "Not kept in the log";
}

/** Why the log holds no copy of an uploaded image: too large, or not kept. */
export function missingImageReason(omitted: unknown): string {
  return omitted === "too_large"
    ? "Larger than the log keeps (2 MB per image)"
    : "Not kept in the log";
}

/** The media type of an OpenAI audio format name. */
export function audioMediaType(format: string | undefined): string {
  switch ((format ?? "").toLowerCase()) {
    case "mp3":
    case "mpeg":
    case "mpga":
      return "audio/mpeg";
    case "opus":
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "webm":
      return "audio/webm";
    default:
      return "audio/wav";
  }
}

/** A short name for a media type in a caption: "MP3", "WAV", "PNG". */
export function mediaFormatLabel(mediaType: string): string {
  const subtype = mediaType.split("/")[1] ?? mediaType;
  if (subtype === "mpeg") return "MP3";
  if (subtype === "mp4") return "M4A";
  return subtype.toUpperCase();
}

/**
 * Raw 16-bit little-endian mono PCM (what streamed gpt-audio and realtime
 * sessions send) as a WAV a browser can play, base64.
 */
export function pcm16ToWav(base64: string, sampleRate = 24_000): string {
  const pcm = atob(base64);
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      header.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  header.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, "data");
  header.setUint32(40, pcm.length, true);
  let headerText = "";
  for (let index = 0; index < 44; index++)
    headerText += String.fromCharCode(header.getUint8(index));
  return btoa(headerText + pcm);
}

/** "1.1 s", "2 min 5 s": a clip's length for a caption. */
export function formatClipSeconds(seconds: number): string {
  if (seconds < 60) return `${Number(seconds.toFixed(1))} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

/** "17.2 KB", "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}
