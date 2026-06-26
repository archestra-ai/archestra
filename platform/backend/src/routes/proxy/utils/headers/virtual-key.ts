import { VIRTUAL_KEY_HEADER } from "@archestra/shared";
import { getHeaderValue } from "./meta-header";

/**
 * Extract the passthrough virtual key token from the X-Archestra-Virtual-Key
 * request header. This token authenticates the acting Archestra user; it never
 * carries a provider credential. Returns undefined when the header is absent.
 *
 * @param headers - The request headers object
 * @returns The raw token if present, undefined otherwise
 */
export function getPassthroughVirtualKeyToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  return getHeaderValue(headers, VIRTUAL_KEY_HEADER) || undefined;
}
