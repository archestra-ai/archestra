import { getBackendBaseUrl } from "@/lib/config";
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
    // Next.js / undici may wrap network errors in AggregateError or `cause`, so
    // drill down to find a Node-style `code` if present.
    const unwrapCode = (error: unknown): string | undefined => {
      if (!error || typeof error !== "object") return undefined;
      const anyErr = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
      if (typeof anyErr.code === "string") return anyErr.code;
      if (anyErr.cause) {
        const nested = (anyErr.cause as any).code ?? (Array.isArray((anyErr.cause as any).errors) ? (anyErr.cause as any).errors[0]?.code : undefined);
        if (typeof nested === "string") return nested;
      }
      if (Array.isArray(anyErr.errors) && anyErr.errors.length > 0) {
        const nested = (anyErr.errors[0] as any)?.code;
        if (typeof nested === "string") return nested;
      }
      return undefined;
    };

    const code = unwrapCode(err);
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
