import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function proxy(req: NextRequest) {
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
      const newHeaders = new Headers(req.headers);
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

  return NextResponse.next();
}

const shouldLogApiRequest = (req: NextRequest) => {
  const { pathname } = req.nextUrl;
  // ignore nextjs internal requests
  if (pathname.startsWith("/_next")) {
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
