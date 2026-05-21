import { cookies } from "next/headers";

/**
 * Get API headers with cookies for server-side requests.
 * This forwards the session cookie from the browser to the backend API.
 *
 * NOTE: This can only be used in Server Components!
 */
export async function getServerApiHeaders() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${encodeCookieValue(cookie.value)}`)
    .join("; ");

  return {
    Cookie: cookieHeader,
  };
}

// HTTP headers are ByteStrings (per WHATWG / RFC 7230); a cookie value
// containing a non-ASCII char (e.g. unicode in a display name) makes
// undici's Headers.set throw and crashes the SSR render. Percent-encode
// only bytes > 127 so already-encoded ASCII values pass through unchanged.
function encodeCookieValue(value: string): string {
  let out = "";
  for (const ch of value) {
    out += ch.codePointAt(0)! <= 127 ? ch : encodeURIComponent(ch);
  }
  return out;
}
