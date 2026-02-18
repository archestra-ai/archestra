import { META_HEADER } from "@shared";

/**
 * Parsed result from the composite X-Archestra-Meta header.
 * Format: external-agent-id/execution-id/session-id
 *
 * Values must not contain "/" since it is used as the segment delimiter.
 */
export interface ParsedMetaHeader {
  externalAgentId?: string;
  executionId?: string;
  sessionId?: string;
}

/**
 * Parse the composite X-Archestra-Meta header.
 * Format: external-agent-id/execution-id/session-id
 *
 * Any segment can be empty (e.g., "/exec-123/" sets only execution-id).
 * Individual headers take precedence over meta header values — this function
 * only parses the meta header itself.
 *
 * Note: Values must not contain "/" since it is used as the segment delimiter.
 *
 * @param headers - The request headers object
 * @returns Parsed meta header segments
 */
export function parseMetaHeader(
  headers: Record<string, string | string[] | undefined>,
): ParsedMetaHeader {
  const raw = getHeaderValue(headers, META_HEADER);

  if (!raw) {
    return {};
  }

  const segments = raw.split("/");

  const externalAgentId =
    segments[0] && segments[0].trim().length > 0
      ? segments[0].trim()
      : undefined;

  const executionId =
    segments[1] && segments[1].trim().length > 0
      ? segments[1].trim()
      : undefined;

  const sessionId =
    segments[2] && segments[2].trim().length > 0
      ? segments[2].trim()
      : undefined;

  return { externalAgentId, executionId, sessionId };
}

/**
 * Get a single header value from the headers object.
 * Handles both string and array values, trims whitespace,
 * and returns undefined for empty/whitespace-only values.
 */
export function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
): string | undefined {
  const headerKey = headerName.toLowerCase();
  const headerValue = headers[headerKey];

  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return headerValue.trim();
  }

  if (Array.isArray(headerValue) && headerValue.length > 0) {
    const firstValue = headerValue[0];
    if (typeof firstValue === "string" && firstValue.trim().length > 0) {
      return firstValue.trim();
    }
  }

  return undefined;
}
