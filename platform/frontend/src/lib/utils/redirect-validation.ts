/**
 * Validates a path to ensure it's a safe relative path for client-side redirects.
 *
 * Accepted patterns:
 * - Simple paths: /dashboard, /settings/teams/123
 * - Paths with query strings: /search?q=hello
 * - Paths with fragments: /docs#api-section
 * - Path traversal sequences: /../foo (browser normalizes these safely)
 *
 * Rejected patterns (open redirect vectors):
 * - Absolute URLs with protocols: https://evil.com, javascript:alert(1)
 * - Protocol-relative URLs: //evil.com (browser treats as https://evil.com)
 * - Paths containing protocol markers: /redirect?url=https://evil.com
 * - Paths containing backslashes: /\evil.com (some browsers normalize to //evil.com)
 *
 * Note: Path traversal (/../) is allowed because browser normalization ensures
 * the final path stays within the application. Double-encoded characters are
 * safe since we decode once and pass directly to router.push().
 *
 * @param path - The path to validate (already decoded)
 * @returns true if the path is a safe relative path
 */
function isValidRelativePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("://") &&
    !path.includes("\\")
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
