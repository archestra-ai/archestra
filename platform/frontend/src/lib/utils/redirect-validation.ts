/**
 * Validates a path to ensure it's a safe relative path.
 * Prevents open redirect attacks by rejecting:
 * - Absolute URLs with protocols (https://evil.com)
 * - Protocol-relative URLs (//evil.com)
 * - URLs containing protocol markers (://)
 *
 * @param path - The path to validate (already decoded)
 * @returns true if the path is a safe relative path
 */
function isValidRelativePath(path: string): boolean {
  return (
    path.startsWith("/") && !path.startsWith("//") && !path.includes("://")
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
 * Used when an absolute URL is required (e.g., for OAuth callbackURL).
 *
 * @param redirectTo - URL-encoded redirect path from query params
 * @returns Full URL with origin if valid, or undefined if invalid
 */
export function getValidatedCallbackURL(
  redirectTo: string | null,
): string | undefined {
  if (!redirectTo) {
    return undefined;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(redirectTo);
  } catch {
    // Malformed URI encoding
    return undefined;
  }

  if (!isValidRelativePath(decodedPath)) {
    return undefined;
  }

  // Return full URL - OAuth libraries expect absolute URLs for callbackURL
  return `${window.location.origin}${decodedPath}`;
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
