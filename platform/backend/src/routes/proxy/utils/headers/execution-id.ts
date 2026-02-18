import { EXECUTION_ID_HEADER } from "@shared";
import { getHeaderValue, parseMetaHeader } from "./meta-header";

/**
 * Extract the execution ID from request headers.
 * Checks X-Archestra-Execution-Id first, then falls back to the
 * second segment of X-Archestra-Meta.
 *
 * @param headers - The request headers object
 * @returns The execution ID if present, undefined otherwise
 */
export function getExecutionId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  // Priority 1: Explicit header
  const explicit = getHeaderValue(headers, EXECUTION_ID_HEADER);
  if (explicit) {
    return explicit;
  }

  // Priority 2: Meta header fallback
  const meta = parseMetaHeader(headers);
  return meta.executionId;
}
