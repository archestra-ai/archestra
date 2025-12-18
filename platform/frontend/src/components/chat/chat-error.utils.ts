import { type ChatErrorResponse, isChatErrorResponse } from "@shared";

/**
 * AI SDK internal error type names that aren't useful to show users
 */
export const AI_SDK_INTERNAL_TYPES = [
  "AI_APICallError",
  "AI_RetryError",
  "APICallError",
  "RetryError",
];

/**
 * Parse the error message to extract a ChatErrorResponse if possible
 */
export function parseErrorResponse(error: Error): ChatErrorResponse | null {
  try {
    const parsed = JSON.parse(error.message);
    if (isChatErrorResponse(parsed)) {
      return parsed;
    }
  } catch {
    // Not JSON or not a ChatErrorResponse
  }
  return null;
}

/**
 * Recursively parse nested JSON strings to produce a clean object
 */
export function deepParseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return deepParseJson(parsed);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map(deepParseJson);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepParseJson(val);
    }
    return result;
  }
  return value;
}

/**
 * Format the original error details for display
 */
export function formatOriginalError(
  originalError: ChatErrorResponse["originalError"],
): string {
  if (!originalError) return "No additional details available";

  const parts: string[] = [];

  if (originalError.provider) {
    parts.push(`Provider: ${originalError.provider}`);
  }
  if (originalError.status) {
    parts.push(`Status: ${originalError.status}`);
  }
  // Skip AI SDK internal type names - not useful for users
  if (
    originalError.type &&
    !AI_SDK_INTERNAL_TYPES.includes(originalError.type)
  ) {
    parts.push(`Type: ${originalError.type}`);
  }
  if (originalError.message) {
    parts.push(`Message: ${originalError.message}`);
  }
  if (originalError.raw) {
    try {
      // Deep parse the raw error to unwrap nested JSON strings
      const parsed = deepParseJson(originalError.raw);
      parts.push(`\nRaw Error:\n${JSON.stringify(parsed, null, 2)}`);
    } catch {
      parts.push(`\nRaw Error: [Unable to stringify]`);
    }
  }

  return parts.join("\n") || "No additional details available";
}
