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
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");

  return {
    Cookie: cookieHeader,
  };
}
