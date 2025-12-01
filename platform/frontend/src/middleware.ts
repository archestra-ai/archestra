import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  if (shouldLogApiRequest(req)) {
    // biome-ignore lint/suspicious/noConsole: Intentional console log of API requests
    console.log(`API Request: ${req.method} ${req.nextUrl.href}`);
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
