import { DEFAULT_INTERNAL_API_BASE_URL } from "@archestra/shared/consts";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const origin = new URL(request.url);
  const response = await fetch(
    new URL(
      "/.well-known/oauth-authorization-server",
      process.env.ARCHESTRA_INTERNAL_API_BASE_URL ||
        DEFAULT_INTERNAL_API_BASE_URL,
    ),
    {
      headers: {
        "X-Forwarded-Host": request.headers.get("host") ?? origin.host,
        "X-Forwarded-Proto": origin.protocol.slice(0, -1),
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );
  return new NextResponse(response.body, {
    status: response.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
