import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

/**
 * This middleware protects routes following below matcher config.
 * It checks for a valid session cookie and redirects to the sign-in page if not found.
 * @param req
 * @returns
 */
export function middleware(req: NextRequest) {
  const session = getSessionCookie(req, {
    cookiePrefix: "archestra",
  });

  if (!session) {
    return NextResponse.redirect(new URL("/auth/sign-in", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - auth/sign-in (login page)
     * - auth/sign-up (registration page)
     * - accept-invitation (invitation acceptance page)
     * - test-agent (public test page)
     * - _next (Next.js internals)
     * - favicon.ico, robots.txt, sitemap.xml (static files)
     */
    "/((?!auth/sign-in|auth/sign-up|accept-invitation|test-agent|_next|public|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
