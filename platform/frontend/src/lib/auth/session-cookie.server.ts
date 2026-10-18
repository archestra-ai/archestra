import {
  DEFAULT_AUTH_COOKIE_PREFIX,
  getAuthSessionCookieNames,
} from "@archestra/shared/consts";

type CookieReader = { has(name: string): boolean };

/**
 * Whether a document request carries a Better Auth session cookie.
 *
 * Only presence is checked: the cookie may be expired or revoked, and the
 * browser's get-session request stays the authority. A cookie is enough to
 * draw the signed-in shell optimistically instead of holding the page for
 * that request. The prefix comes from the same `ARCHESTRA_AUTH_COOKIE_PREFIX`
 * the backend names its cookies with (both processes share one container).
 */
export function hasSessionCookie(
  cookies: CookieReader,
  prefix = process.env.ARCHESTRA_AUTH_COOKIE_PREFIX?.trim() ||
    DEFAULT_AUTH_COOKIE_PREFIX,
): boolean {
  return getAuthSessionCookieNames(prefix).some((name) => cookies.has(name));
}
