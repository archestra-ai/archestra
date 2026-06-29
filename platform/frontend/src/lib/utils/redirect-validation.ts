/**
 * Validates a path to ensure it's a safe relative path for client-side redirects.
 *
 * Accepted patterns:
 * - Simple paths: /dashboard, /settings/teams/123
 * - Paths with query strings: /search?q=hello
 * - Paths with fragments: /docs#api-section
 * - Path traversal sequences: /../foo (browser normalizes these safely)
 * - Paths with protocol URLs in query params: /oauth/consent?redirect_uri=cursor://...
 *
 * Rejected patterns (open redirect vectors):
 * - Absolute URLs with protocols: https://evil.com, javascript:alert(1)
 * - Protocol-relative URLs: //evil.com (browser treats as https://evil.com)
 * - Path portion containing protocol markers: /https://evil.com
 * - Path portion containing backslashes: /\evil.com (some browsers normalize to //evil.com)
 *
 * Note: Protocol markers (://) and backslashes are only checked in the path portion
 * (before the query string). Query parameter values may legitimately contain protocol
 * URLs (e.g., redirect_uri=cursor://...) which are just data, not redirect targets.
 *
 * Path traversal (/../) is allowed because browser normalization ensures
 * the final path stays within the application. Double-encoded characters are
 * safe since we decode once and pass directly to router.push().
 *
 * @param path - The path to validate (already decoded)
 * @returns true if the path is a safe relative path
 */
function isValidRelativePath(path: string): boolean {
  // Only check for protocol markers and backslashes in the path portion (before query string).
  // Query parameter values may legitimately contain protocol URLs (e.g., redirect_uri=cursor://...)
  const pathPortion = path.split("?")[0];
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !pathPortion.includes("://") &&
    !pathPortion.includes("\\")
  );
}

/**
 * Validates and decodes a redirectTo parameter to prevent open redirect attacks.
 * Returns the decoded path if valid, or "/" if invalid.
 *
 * @param redirectTo - URL-encoded redirect path from query params
 * @returns Validated relative path or "/" as fallback
 */
export function getValidatedRedirectPath(redirectTo: string | null): string {
  if (!redirectTo) {
    return "/";
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(redirectTo);
  } catch {
    // Malformed URI encoding
    return "/";
  }

  return isValidRelativePath(decodedPath) ? decodedPath : "/";
}

/**
 * Validates and decodes a redirectTo parameter, returning a full URL with origin.
 * Falls back to home page URL if redirectTo is invalid or not provided.
 * Used for SSO flows where a callback URL is always required.
 *
 * @param redirectTo - URL-encoded redirect path from query params
 * @returns Full URL with origin (defaults to home page)
 */
export function getValidatedCallbackURLWithDefault(
  redirectTo: string | null,
): string {
  const validatedPath = getValidatedRedirectPath(redirectTo);
  return `${window.location.origin}${validatedPath}`;
}
