/**
 * Media a log row does not keep, which is the default: an organization keeps
 * it only with "Keep media in logs" on. Media means the images, audio, video
 * and files that LLM requests, responses and MCP tool calls carry as bytes.
 * Each is replaced where it stood by `MEDIA_NOT_KEPT`, so the row keeps its
 * shape, the text around the media, and the media's place and type. Links to
 * media (an `https://` image URL, a Gemini `fileData` URI) are not bytes and
 * stay. Only a known media shape is stripped: a part typed as media, an object
 * naming a media type, or a provider's audio container; generic names such as
 * `source` or `data` alone never are.
 */
export const MEDIA_NOT_KEPT = "media-not-kept";

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
 * held as a string, such as a tool result sent to a model as text. Content
 * nested deeper than a log can use, counting JSON inside strings, is replaced
 * by `NESTED_TOO_DEEPLY`, so the result is always safe to serialize. Returns a
 * copy where something changed and the input itself where nothing did; the
 * input is never modified.
 */
export function withoutLoggedMedia<T>(value: T): T {
  return strip(value, { depth: 0, inMedia: false }) as T;
}

// ===
// Internal helpers
// ===

/** Stands in for content nested deeper than `MAX_DEPTH`. */
const NESTED_TOO_DEEPLY = "[nested too deeply to log]";

/** Deeper than any provider or tool payload; bounds the stack and the work. */
const MAX_DEPTH = 64;

/**
 * A base64 `data:` URL, alone or inside text; the first group is its media
 * type. Parameters such as `;name=photo.png` may come before `;base64`.
 */
const BASE64_DATA_URL =
  /data:([\w.+-]+\/[\w.+-]+)?(?:;(?!base64,)[^;,\s"']*)*;base64,[A-Za-z0-9+/_=-]*/gi;

/** A value made only of base64 characters (standard or URL-safe alphabet). */
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Keys whose base64 string is media bytes wherever they appear. */
const MEDIA_BYTES_KEYS = new Set([
  "b64_json",
  "partial_image_b64",
  "image_base64",
  "file_data",
]);

/** Keys of provider containers whose `data` is media bytes. */
const MEDIA_CONTAINERS = new Set([
  "audio",
  "input_audio",
  "output_audio",
  "inlineData",
  "inline_data",
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

/** Keys naming the media type of the bytes beside or below them. */
const MEDIA_TYPE_KEYS = [
  "mimeType",
  "mime_type",
  "media_type",
  "mediaType",
  "content_type",
  "contentType",
  "format",
];

/** A media type, or an audio, image or video format name as providers spell them. */
const MEDIA_TYPE =
  /^(?:(?:image|audio|video|application)\/[\w.+-]+|wav|mp3|mpeg|pcm16|pcm|g711_ulaw|g711_alaw|flac|opus|ogg|aac|webm|m4a|mp4|mov|mkv|png|jpe?g|webp|gif|pdf)$/i;

interface Walk {
  depth: number;
  /** Inside an object already known to be media, such as Bedrock's `image`. */
  inMedia: boolean;
}

function strip(value: unknown, walk: Walk): unknown {
  if (typeof value === "string") return stripText(value, walk.depth);
  if (typeof value !== "object" || value === null) return value;
  if (walk.depth >= MAX_DEPTH) return NESTED_TOO_DEEPLY;
  const inner = { depth: walk.depth + 1, inMedia: walk.inMedia };
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = strip(item, inner);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  const object = value as Record<string, unknown>;
  const holdsMedia = isMedia(object, walk.inMedia);
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(object)) {
    const next = mediaBytes(object, field, item, holdsMedia)
      ? MEDIA_NOT_KEPT
      : field === "images" && Array.isArray(item) && isMessage(object)
        ? withoutBareImages(item)
        : strip(item, {
            depth: inner.depth,
            inMedia: holdsMedia || MEDIA_CONTAINERS.has(field),
          });
    if (next !== item) changed = true;
    result[field] = next;
  }
  return changed ? result : value;
}

/**
 * Whether an object is media: a part typed as media, an object naming a media
 * type, a Bedrock image, document or video block, or anything inside one. A
 * source typed as text or a URL holds no bytes.
 */
function isMedia(object: Record<string, unknown>, inMedia: boolean): boolean {
  if (object.type === "text" || object.type === "url") return false;
  return (
    inMedia ||
    (typeof object.type === "string" && MEDIA_PART_TYPES.has(object.type)) ||
    isBedrockMediaBlock(object) ||
    MEDIA_TYPE_KEYS.some(
      (typeKey) =>
        typeof object[typeKey] === "string" &&
        MEDIA_TYPE.test(object[typeKey] as string),
    )
  );
}

function mediaBytes(
  object: Record<string, unknown>,
  field: string,
  item: unknown,
  holdsMedia: boolean,
): boolean {
  if (typeof item !== "string" || !isBase64(item)) return false;
  return (
    MEDIA_BYTES_KEYS.has(field) ||
    (holdsMedia && (field === "data" || field === "bytes")) ||
    // An MCP resource's binary contents.
    (field === "blob" && typeof object.uri === "string") ||
    // A Responses image generation returns its image as `result`.
    (field === "result" && object.type === "image_generation_call")
  );
}

/**
 * Bedrock's image, document and video blocks: a format beside source bytes,
 * whatever the format (`txt`, `csv` and `docx` documents included).
 */
function isBedrockMediaBlock(object: Record<string, unknown>): boolean {
  const source = object.source;
  return (
    typeof object.format === "string" &&
    typeof source === "object" &&
    source !== null &&
    typeof (source as Record<string, unknown>).bytes === "string"
  );
}

/** A chat message; Ollama sends its images as bare base64 strings. */
function isMessage(object: Record<string, unknown>): boolean {
  return typeof object.role === "string";
}

function withoutBareImages(images: unknown[]): unknown[] {
  let changed = false;
  const items = images.map((item) => {
    if (typeof item !== "string" || !isBase64(item)) return item;
    changed = true;
    return MEDIA_NOT_KEPT;
  });
  return changed ? items : images;
}

function stripText(value: string, depth: number): string {
  const first = value.trimStart()[0];
  if (first === "{" || first === "[") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const stripped = strip(parsed, { depth: depth + 1, inMedia: false });
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
