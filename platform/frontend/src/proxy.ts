import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function proxy(req: NextRequest) {
  // Redirect root to /chat before any client components render
  if (req.nextUrl.pathname === "/") {
    return NextResponse.redirect(new URL("/chat", req.url));
  }

  if (shouldLogApiRequest(req)) {
    // biome-ignore lint/suspicious/noConsole: Intentional console log of API requests
    console.log(`API Request: ${req.method} ${req.nextUrl.href}`);
  }

  // Handle SAML SSO callbacks by replacing the null Origin header
  // This is needed because:
  // 1. SAML IdPs POST to the ACS URL via cross-origin form submission
  // 2. Browsers send Origin: null for such requests
  // 3. Better Auth rejects Origin: null with MISSING_OR_NULL_ORIGIN error
  // 4. We replace null with the legitimate frontend origin
  if (isSamlCallback(req)) {
    const origin = req.headers.get("origin");

    if (origin === "null" || !origin) {
      // Create a new request with the modified Origin header
      const frontendOrigin =
        process.env.ARCHESTRA_FRONTEND_URL || "http://localhost:3000";

      // Create new headers with the replaced Origin
      const newHeaders = withForwardedOrigin(req);
      newHeaders.set("Origin", frontendOrigin);

      // Create the rewritten request with modified headers
      const backendUrl =
        process.env.ARCHESTRA_INTERNAL_API_BASE_URL || "http://localhost:9000";
      const backendRequestUrl = new URL(req.nextUrl.pathname, backendUrl);
      backendRequestUrl.search = req.nextUrl.search;

      // Return a rewrite that fetches from the backend with modified headers
      return NextResponse.rewrite(backendRequestUrl, {
        request: {
          headers: newHeaders,
        },
      });
    }
  }

  // For requests proxied to the backend, preserve the public host/proto the
  // client used so the backend's getPublicRequestOrigin() advertises the right
  // OAuth protected-resource / token / jwks origin. Without this it falls back
  // to its own origin (e.g. localhost:9000) and MCP clients connecting via the
  // frontend origin (localhost:3000) fail with a resource mismatch.
  if (needsForwardedOrigin(req.nextUrl.pathname)) {
    return NextResponse.next({
      request: { headers: withForwardedOrigin(req) },
    });
  }

  return NextResponse.next();
}

/**
 * Clone the request headers, injecting `X-Forwarded-Host`/`X-Forwarded-Proto`
 * from the incoming request when not already set. Values set by a real
 * proxy/ingress in front of the frontend (e.g. an ngrok tunnel) are preserved,
 * so this is a no-op when the public origin is terminated upstream.
 */
const withForwardedOrigin = (req: NextRequest) => {
  const headers = new Headers(req.headers);

  const host = req.headers.get("host");
  if (host && !headers.has("x-forwarded-host")) {
    headers.set("x-forwarded-host", host);
  }

  if (!headers.has("x-forwarded-proto")) {
    headers.set("x-forwarded-proto", req.nextUrl.protocol.replace(/:$/, ""));
  }

  return headers;
};

const needsForwardedOrigin = (pathname: string) =>
  pathname.startsWith("/v1/") ||
  pathname.startsWith("/.well-known/") ||
  pathname.startsWith("/api/");

const shouldLogApiRequest = (req: NextRequest) => {
  const { pathname } = req.nextUrl;
  // ignore nextjs internal requests
  if (pathname.startsWith("/_next")) {
    return false;
  }
  // ignore MCP gateway GET polling requests to reduce log noise
  if (req.method === "GET" && pathname.startsWith("/v1/mcp/")) {
    return false;
  }
  // log request before it is proxied via nextjs rewrites
  // see rewrites() config in next.config.ts
  return pathname.startsWith("/api") || pathname.startsWith("/v1");
};

const isSamlCallback = (req: NextRequest) => {
  const { pathname } = req.nextUrl;
  // Match SAML ACS callback URLs: /api/auth/sso/saml2/sp/acs/*
  return (
    req.method === "POST" && pathname.startsWith("/api/auth/sso/saml2/sp/acs/")
  );
};
