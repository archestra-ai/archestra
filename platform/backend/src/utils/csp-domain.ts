/**
 * Canonical grammar for a CSP source host, used by the serve-time filter
 * (`server.ts` `sanitizeCspDomains`, which drops invalid entries from an
 * external MCP-UI app's declared CSP). Owned apps no longer carry an
 * author-controlled CSP — they render under the hardcoded `APP_PLATFORM_CSP`
 * (services/apps/app-ui-policy.ts), whose bare hostnames this grammar accepts.
 *
 * A host is one or more dot-separated alphanumeric labels (hyphens allowed
 * internally) ending in an alphabetic TLD, with an optional single leading
 * `*.` wildcard. No spaces, schemes, paths, or other CSP source-list tokens can
 * match, so the validator cannot pass an injection into a CSP directive.
 */
const HOST = String.raw`(?:\*\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}`;

// A bare host optionally wrapped with an http(s)/ws(s) scheme and a port,
// matching what a CSP source list legitimately carries.
const CSP_SOURCE = new RegExp(
  `^(?:wss?:\\/\\/|https?:\\/\\/)?${HOST}(?::\\d{1,5})?$`,
);

/** True if `value` is a CSP source (optional scheme + host + optional port). */
export function isCspSource(value: string): boolean {
  return CSP_SOURCE.test(value);
}
