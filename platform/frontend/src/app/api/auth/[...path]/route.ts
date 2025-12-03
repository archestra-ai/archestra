import { type NextRequest, NextResponse } from "next/server";

import { getBackendBaseUrl } from "@/lib/config";

/**
 * This catch-all route handles all `/api/auth/*` requests and forwards them to the backend.
 *
 * We need this explicit route handler instead of using Next.js rewrites because rewrites
 * don't properly forward all browser headers (including Origin) for server-to-server requests.
 *
 * This is critical for SAML SSO callbacks which require the Origin header to be forwarded:
 * - SAML IdPs send POST requests to the ACS (Assertion Consumer Service) URL via cross-origin form submissions
 * - Browsers set the Origin header to "null" for these cross-origin form POSTs
 * - Better Auth validates this Origin header against the trusted origins list
 * - Without proper forwarding, the Origin header is lost and Better Auth rejects the request
 */
async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const pathString = path.join("/");
  const url = new URL(`/api/auth/${pathString}`, getBackendBaseUrl());

  // Copy query parameters
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  // Get the original request headers and ensure Origin is forwarded
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    // Skip host header as we're changing the destination
    if (key.toLowerCase() !== "host") {
      headers.set(key, value);
    }
  });

  // Explicitly set the Origin header if present in the original request
  // This is critical for SAML callbacks where Origin: null must be forwarded
  const origin = request.headers.get("origin");
  if (origin) {
    headers.set("Origin", origin);
  }

  // Forward the request to the backend
  const response = await fetch(url.toString(), {
    method: request.method,
    headers,
    body:
      request.method !== "GET" && request.method !== "HEAD"
        ? await request.text()
        : undefined,
    redirect: "manual", // Don't follow redirects, let the browser handle them
  });

  // Create response headers, copying from backend response
  const responseHeaders = new Headers();
  response.headers.forEach((value, key) => {
    // Don't forward certain headers that Next.js manages
    if (
      !["content-encoding", "transfer-encoding"].includes(key.toLowerCase())
    ) {
      responseHeaders.set(key, value);
    }
  });

  // Return the response with the same status and headers
  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
