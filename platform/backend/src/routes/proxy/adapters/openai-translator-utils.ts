export function stringifyTextContent(
  content: unknown,
  separator = "\n",
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(separator);
}

// Parses a base64 data URL (`data:<mime>;base64,<payload>`) into its MIME type
// and raw base64 payload. Returns null for plain http(s) URLs or malformed
// input so callers can fall back to a URL reference or drop the part. Used by
// the non-OpenAI-wire translators to forward inline images/files instead of
// dropping every non-text content part.
export function parseDataUrl(
  url: string,
): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), data: match[2] };
}

// Provider-agnostic view of an OpenAI message content part. The non-OpenAI-wire
// translators normalize `content` into these once, then map each part into
// their provider-native shape — so the OpenAI parsing rules live in one place.
export type NormalizedContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string }
  | { kind: "audio"; data: string; format: string }
  | { kind: "file"; fileData: string; filename?: string };

// Normalizes an OpenAI message `content` (string or array of content parts)
// into a flat list of typed parts, preserving images/files/audio instead of
// dropping every non-text part. A plain string becomes a single text part;
// empty text and unrecognized parts are skipped.
export function normalizeOpenAiContentParts(
  content: unknown,
): NormalizedContentPart[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts: NormalizedContentPart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;

    if (part.type === "text") {
      const text = readStringField(part, "text");
      if (text) parts.push({ kind: "text", text });
    } else if (part.type === "image_url") {
      const url = readStringField(part.image_url, "url");
      if (url) parts.push({ kind: "image", url });
    } else if (part.type === "input_audio") {
      const data = readStringField(part.input_audio, "data");
      const format = readStringField(part.input_audio, "format");
      if (data && format) parts.push({ kind: "audio", data, format });
    } else if (part.type === "file") {
      const fileData = readStringField(part.file, "file_data");
      const filename = readStringField(part.file, "filename");
      if (fileData) {
        parts.push({ kind: "file", fileData, filename: filename || undefined });
      }
    }
  }
  return parts;
}

function readStringField(value: unknown, key: string): string {
  if (value && typeof value === "object") {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string") return field;
  }
  return "";
}

export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Translators should preserve request flow if provider-returned tool
    // arguments are malformed. Treat them as an empty argument object.
    return {};
  }

  return {};
}
