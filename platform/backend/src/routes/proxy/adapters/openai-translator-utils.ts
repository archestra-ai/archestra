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
