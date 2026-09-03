import { RUN_ID_HEADER } from "@archestra/shared";
import { getHeaderValue, parseMetaHeader } from "./meta-header";

/**
 * Extract the run ID from request headers.
 * Checks X-Archestra-Run-Id first, then falls back to the
 * second segment of X-Archestra-Meta.
 *
 * @param headers - The request headers object
 * @returns The run ID if present, undefined otherwise
 */
export function getRunId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  // Priority 1: Explicit header
  const explicit = getHeaderValue(headers, RUN_ID_HEADER);
  if (explicit) {
    return explicit;
  }

  // Priority 2: Meta header fallback
  const meta = parseMetaHeader(headers);
  return meta.runId;
}
