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
