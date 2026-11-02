import { isMediaNotKept, MEDIA_NOT_KEPT_REASON } from "../../log-media";
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
  if (isMediaNotKept(params.data)) return notKeptPart(params);
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
  if (isMediaNotKept(params.url)) return notKeptPart(params);
  return {
    type: "file",
    mediaType: params.mediaType,
    url: params.url,
    ...(params.caption ? { filename: params.caption } : {}),
  };
}

/** Media the call carried that the log did not keep: what it was, and why. */
export function missingMediaPart(params: {
  kind: MediaKind;
  label: string;
  reason: string;
}): Part {
  return { type: "data-missing-media", data: params } as Part;
}

type MediaKind = "audio" | "image" | "video" | "file";

/** The kind of media a media type names, for its placeholder's icon. */
function mediaKind(mediaType: string): MediaKind {
  const [type] = mediaType.split("/");
  return type === "audio" || type === "image" || type === "video"
    ? type
    : "file";
}

/** A placeholder for media the organization keeps out of its logs. */
function notKeptPart(params: { mediaType: string; caption?: string }): Part {
  const kind = mediaKind(params.mediaType);
  return missingMediaPart({
    kind,
    label:
      params.caption ??
      (params.mediaType.endsWith("/*")
        ? { audio: "Audio", image: "Image", video: "Video", file: "File" }[kind]
        : mediaFormatLabel(params.mediaType)),
    reason: MEDIA_NOT_KEPT_REASON,
  });
}

/** Why the log holds no copy of a clip: too large, or not kept at all. */
export function missingAudioReason(omitted: unknown): string {
  return omitted === "too_large"
    ? "Longer than the log keeps (2 MB per clip)"
    : "Not kept in the log";
}

/**
 * An Images edit's uploads as its log row keeps them (`input_files`): each
 * image, and the mask, with its bytes when the log kept them.
 */
export type ImageEditUploads = { images?: ImageUpload[]; mask?: ImageUpload };

/**
 * An edit's uploaded images, then its mask, for the user's turn: each shown
 * inline, or as a named placeholder saying why the log has no copy.
 */
export function imageEditUploadParts(
  files: ImageEditUploads | undefined,
): Part[] {
  return [
    ...(files?.images ?? []).map((upload) =>
      uploadPart({ upload, fallbackName: "Input image" }),
    ),
    ...(files?.mask
      ? [uploadPart({ upload: files.mask, fallbackName: "Mask", role: "Mask" })]
      : []),
  ];
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
  // Nothing to wrap: the log did not keep the clip.
  if (isMediaNotKept(base64)) return base64;
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

/** An edit's uploaded image: its metadata, and its bytes when the log kept them. */
type ImageUpload = {
  filename?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  data?: string;
  data_omitted?: string;
};

/** "circle.png · 1024 × 1024" shown inline, or a placeholder saying why not. */
function uploadPart(params: {
  upload: ImageUpload;
  fallbackName: string;
  role?: string;
}): Part {
  const { upload, fallbackName, role } = params;
  const caption = [
    role && upload.filename ? `${role}: ${upload.filename}` : upload.filename,
    upload.width && upload.height
      ? `${upload.width} × ${upload.height}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return upload.data
    ? inlineMediaPart({
        mediaType: upload.mime_type ?? "image/png",
        data: upload.data,
        caption: caption || fallbackName,
      })
    : missingMediaPart({
        kind: "image",
        label: caption || fallbackName,
        reason: missingImageReason(upload.data_omitted),
      });
}

/** Why the log holds no copy of an uploaded image: too large, or not kept. */
function missingImageReason(omitted: unknown): string {
  return omitted === "too_large"
    ? "Larger than the log keeps (2 MB per image)"
    : "Not kept in the log";
}
