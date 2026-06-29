/**
 * Unwrap extra text block wrapping from tool result content.
 *
 * Some clients (like n8n, Vercel AI SDK) wrap tool results in a text block structure:
 * - Input: "[{\"type\":\"text\",\"text\":\"{\\\"data\\\":...}\"}]"
 * - Output: "{\"data\":...}"
 *
 * Or as an array:
 * - Input: [{"type":"text","text":"{\"data\":...}"}]
 * - Output: "{\"data\":...}"
 *
 * This is necessary for TOON conversion which expects the raw JSON string,
 * not wrapped in additional structures.
 */
export function unwrapToolContent(content: string | unknown): string {
  // Convert to string if it's not already
  const contentStr =
    typeof content === "string" ? content : JSON.stringify(content);

  try {
    const parsed = JSON.parse(contentStr);

    // Check for wrapper format: [{"type":"text","text":"..."}]
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed[0]?.type === "text" &&
      typeof parsed[0]?.text === "string"
    ) {
      // Return the unwrapped text content
      return parsed[0].text;
    }

    // Not wrapped, return as-is
    return contentStr;
  } catch {
    // Not valid JSON, return as-is
    return contentStr;
  }
}
