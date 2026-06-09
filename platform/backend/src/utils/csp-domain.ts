/**
 * Canonical grammar for a CSP source host, shared by the app save-time gate
 * (`services/apps/app-ui-policy.ts`, which rejects) and the serve-time filter
 * (`server.ts` `sanitizeCspDomains`, which drops). Keeping one source fragment
 * guarantees that anything accepted on save survives at serve time — a divergent
 * copy previously dropped valid hostnames with digit-bearing labels (s3, v2).
 *
 * A host is one or more dot-separated alphanumeric labels (hyphens allowed
 * internally) ending in an alphabetic TLD, with an optional single leading
 * `*.` wildcard. No spaces, schemes, paths, or other CSP source-list tokens can
 * match, so neither validator can pass an injection into a CSP directive.
 */
const HOST = String.raw`(?:\*\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}`;

// Save-time: a bare host only — no scheme prefix, no port (stricter than serve).
const CSP_HOSTNAME = new RegExp(`^${HOST}$`);

// Serve-time: a bare host optionally wrapped with an http(s)/ws(s) scheme and
// a port, matching what a CSP source list legitimately carries.
const CSP_SOURCE = new RegExp(
  `^(?:wss?:\\/\\/|https?:\\/\\/)?${HOST}(?::\\d{1,5})?$`,
);

/** True if `value` is a bare CSP host (no scheme/port). Used at save time. */
export function isCspHostname(value: string): boolean {
  return CSP_HOSTNAME.test(value);
}

/** True if `value` is a CSP source (optional scheme + host + optional port). */
export function isCspSource(value: string): boolean {
  return CSP_SOURCE.test(value);
}
