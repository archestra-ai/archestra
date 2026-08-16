// The mock backend for server-side rendering.
//
// Under the Playwright integration tests, `ARCHESTRA_INTERNAL_API_BASE_URL`
// points at this route, so every server component's SDK call becomes an
// ordinary HTTP request to `/internal-test/api/<backend path>` and is answered
// from the same MSW handler chain the browser worker uses. Server-side mocking
// therefore no longer depends on network interception surviving Next.js dev
// recompiles.
//
// Gated by NEXT_PUBLIC_API_MOCKING=enabled — 404 outside the test runtime, so a
// production deployment cannot serve fixtures from here.

import { isApiRequest } from "@/mocks/match";
import { resolveMockResponse } from "@/mocks/resolve";

export const dynamic = "force-dynamic";

const ENABLED =
  process.env.NEXT_PUBLIC_API_MOCKING === "enabled" &&
  process.env.NODE_ENV !== "production";

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (!ENABLED) return new Response("Not found", { status: 404 });

  const { path } = await context.params;
  const incoming = new URL(request.url);
  // Handlers are registered against backend-relative paths, so strip the
  // `/internal-test/api` prefix back off before matching.
  const target = new URL(
    `/${path.join("/")}${incoming.search}`,
    incoming.origin,
  );

  const body = METHODS_WITHOUT_BODY.has(request.method)
    ? undefined
    : await request.arrayBuffer();

  const response = await resolveMockResponse(
    new Request(target, {
      method: request.method,
      headers: request.headers,
      body,
    }),
  );
  if (response) return response;

  // No handler matched. Record it so the Playwright fixture fails the test with
  // the offending URL, and answer 5xx so the caller sees a fault instead of
  // mistaking an unmocked endpoint for a meaningful empty response.
  if (isApiRequest(target.toString())) {
    globalThis.__archestraUnhandledRequests ??= [];
    globalThis.__archestraUnhandledRequests.push(
      `${request.method} ${target.pathname}${target.search}`,
    );
  }
  return Response.json(
    { error: "no_msw_handler", method: request.method, url: target.pathname },
    { status: 501 },
  );
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
