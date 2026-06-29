declare global {
  // eslint-disable-next-line no-var
  var __archestraUnhandledRequests: string[] | undefined;
}

// Predicate for "this URL is a backend API call we expect MSW to mock."
// Aligned with the Next.js rewrite patterns in next.config.ts:51-87 — anything
// that would otherwise be proxied to the backend origin counts.
//
// We also restrict by host to localhost/127.0.0.1 so third-party `/api/*` URLs
// (Next.js telemetry → telemetry.nextjs.org, Sentry, PostHog, etc.) don't
// register as gaps. WebSocket protocols are skipped — MSW doesn't intercept
// WebSocket upgrades.
//
// Used by both Node and browser MSW `onUnhandledRequest` callbacks to decide
// whether to fail the test or silently bypass.

const API_PATH_PREFIXES = [
  "/api/",
  "/v1/",
  "/.well-known/",
  "/_sandbox/",
] as const;

const API_EXACT_PATHS = ["/health"] as const;

const TRACKED_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function isApiRequest(url: string): boolean {
  let urlObj: URL;
  try {
    urlObj = url.startsWith("/")
      ? new URL(url, "http://localhost")
      : new URL(url);
  } catch {
    return false;
  }
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") return false;
  if (!TRACKED_HOSTS.has(urlObj.hostname)) return false;

  const pathname = urlObj.pathname;
  return (
    API_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    API_EXACT_PATHS.includes(pathname as (typeof API_EXACT_PATHS)[number])
  );
}
