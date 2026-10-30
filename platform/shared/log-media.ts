/**
 * Media a log row does not keep when an organization turns off "Keep media in
 * logs": the images, audio, video and files that LLM requests, responses and
 * MCP tool calls carry as bytes. Each is replaced where it stood by
 * `MEDIA_NOT_KEPT`, so the row keeps its shape, the text around the media, and
 * the media's place and type. Links to media (an `https://` image URL, a
 * Gemini `fileData` URI) are not bytes and stay.
 */
export const MEDIA_NOT_KEPT = "media-not-kept";

/**
 * A base64 `data:` URL, alone or inside text; the first group is its media
 * type. Parameters such as `;name=photo.png` may come before `;base64`.
 */
const BASE64_DATA_URL =
  /data:([\w.+-]+\/[\w.+-]+)?(?:;(?!base64,)[^;,\s"']*)*;base64,[A-Za-z0-9+/_=-]*/gi;

/** A value made only of base64 characters (standard or URL-safe alphabet). */
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Keys whose base64 string is media bytes in any object. */
const MEDIA_BYTES_KEYS = new Set([
  "b64_json",
  "partial_image_b64",
  "image_base64",
  "file_data",
  "bytes",
  "blob",
]);

/** Objects whose `data` is media bytes, by the key that holds them. */
const MEDIA_CONTAINERS = new Set([
  "audio",
  "input_audio",
  "output_audio",
  "upload",
  "inlineData",
  "inline_data",
  "source",
]);

/** Content part types whose `data` is media bytes. */
const MEDIA_PART_TYPES = new Set([
  "image",
  "audio",
  "video",
  "document",
  "file",
  "input_audio",
  "base64",
]);

/** Keys naming the media type of the bytes beside them. */
const MEDIA_TYPE_KEYS = [
  "mimeType",
  "mime_type",
  "media_type",
  "mediaType",
  "content_type",
  "contentType",
  "format",
];

/** A media type, or an audio or image format name as providers spell them. */
const MEDIA_TYPE =
  /^(?:(?:image|audio|video|application)\/[\w.+-]+|wav|mp3|mpeg|pcm16|pcm|g711_ulaw|g711_alaw|flac|opus|ogg|aac|webm|m4a|png|jpe?g|webp|gif|pdf)$/i;

/**
 * Whether a log value is media the log did not keep: the marker itself, the
 * `data:` URL it leaves, or a `data:` URL a reader built around the marker.
 */
export function isMediaNotKept(value: unknown): boolean {
  return (
    value === MEDIA_NOT_KEPT ||
    (typeof value === "string" &&
      value.startsWith("data:") &&
      (value.endsWith(`;${MEDIA_NOT_KEPT},`) ||
        value.endsWith(`,${MEDIA_NOT_KEPT}`)))
  );
}

/** What Logs says about media the organization keeps out of its logs. */
export const MEDIA_NOT_KEPT_REASON = "Not kept: media logging is off";

/**
 * The value with every media payload replaced by `MEDIA_NOT_KEPT` (a base64
 * `data:` URL keeps its media type: `data:image/png;media-not-kept,`). Media
 * is found in structured content, in `data:` URLs inside text, and in JSON
 * held as a string, such as a tool result sent to a model as text. Returns a
 * copy where something changed and the input itself where nothing did; the
 * input is never modified.
 */
export function withoutLoggedMedia<T>(value: T): T {
  return strip(value, undefined) as T;
}

function strip(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string") return stripText(value);
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      // Ollama sends a message's images as bare base64 strings.
      const next =
        key === "images" && typeof item === "string" && isBase64(item)
          ? MEDIA_NOT_KEPT
          : strip(item, undefined);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  const holdsMedia =
    (key !== undefined && MEDIA_CONTAINERS.has(key)) ||
    (typeof object.type === "string" && MEDIA_PART_TYPES.has(object.type)) ||
    MEDIA_TYPE_KEYS.some(
      (typeKey) =>
        typeof object[typeKey] === "string" &&
        MEDIA_TYPE.test(object[typeKey] as string),
    );
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(object)) {
    const bytes =
      typeof item === "string" &&
      isBase64(item) &&
      (MEDIA_BYTES_KEYS.has(field) ||
        (field === "data" && holdsMedia) ||
        // A Responses image generation returns its image as `result`.
        (field === "result" && object.type === "image_generation_call"));
    const next = bytes ? MEDIA_NOT_KEPT : strip(item, field);
    if (next !== item) changed = true;
    result[field] = next;
  }
  return changed ? result : value;
}

function stripText(value: string): string {
  const first = value.trimStart()[0];
  if (first === "{" || first === "[") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const stripped = strip(parsed, undefined);
      return stripped === parsed ? value : JSON.stringify(stripped);
    }
  }
  if (!value.includes("base64,")) return value;
  return value.replace(
    BASE64_DATA_URL,
    (_match, type: string | undefined) =>
      `data:${type ?? ""};${MEDIA_NOT_KEPT},`,
  );
}

function isBase64(value: string): boolean {
  return value.length > 0 && BASE64.test(value);
}
