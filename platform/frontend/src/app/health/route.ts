import { getBackendBaseUrl } from "@/lib/config";
import { unwrapNetworkErrorCode } from "@/lib/utils";
import { NextResponse } from "next/server";

/**
 * Proxy GET /health to the backend. When the backend is down (ECONNREFUSED),
 * return 503 with a clear message instead of throwing.
 */
export async function GET() {
  const backendUrl = getBackendBaseUrl();
  const healthUrl = `${backendUrl.replace(/\/$/, "")}/health`;

  try {
    const res = await fetch(healthUrl, { cache: "no-store" });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (err: unknown) {
    const code = unwrapNetworkErrorCode(err);
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") {
      return NextResponse.json(
        {
          error: "Backend unreachable",
          message: "Start the full app from platform root: pnpm dev (backend must be running on port 9000).",
        },
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    throw err;
  }
}
