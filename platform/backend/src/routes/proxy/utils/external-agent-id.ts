import { EXTERNAL_AGENT_ID_HEADER } from "@shared";

/**
 * Extract the external agent ID from request headers.
 * This allows clients to associate interactions with their own agent identifiers
 * by passing the X-Archestra-Agent-Id header.
 *
 * @param headers - The request headers object
 * @returns The external agent ID if present, undefined otherwise
 */
export function getExternalAgentId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  // HTTP headers are case-insensitive, so we check lowercase
  const headerKey = EXTERNAL_AGENT_ID_HEADER.toLowerCase();
  const headerValue = headers[headerKey];

  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return headerValue.trim();
  }

  // Handle case where header might be an array (though unusual for this header)
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    const firstValue = headerValue[0];
    if (typeof firstValue === "string" && firstValue.trim().length > 0) {
      return firstValue.trim();
    }
  }

  return undefined;
}
