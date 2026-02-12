import { EXTERNAL_AGENT_ID_HEADER } from "@shared";
import { getHeaderValue, parseMetaHeader } from "./meta-header";

/**
 * Extract the external agent ID from request headers.
 * Checks X-Archestra-Agent-Id first, then falls back to the
 * first segment of X-Archestra-Meta.
 *
 * @param headers - The request headers object
 * @returns The external agent ID if present, undefined otherwise
 */
export function getExternalAgentId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  // Priority 1: Explicit header
  const explicit = getHeaderValue(headers, EXTERNAL_AGENT_ID_HEADER);
  if (explicit) {
    return explicit;
  }

  // Priority 2: Meta header fallback
  const meta = parseMetaHeader(headers);
  return meta.externalAgentId;
}
