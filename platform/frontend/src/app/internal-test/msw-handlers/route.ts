// Control endpoint for per-test MSW handler overrides used by Playwright
// integration tests. Gated by NEXT_PUBLIC_API_MOCKING=enabled — returns 404
// outside the test runtime so production deployments cannot register handlers.
//
// Overrides are applied to two runtimes:
//   - Node `setupServer` (intercepts SSR fetches from Next.js server components)
//   - Browser `setupWorker` (intercepts client-side fetches from the page)
//
// POST registers on Node immediately and persists the descriptor in
// `globalThis.__archestraMswOverrides`. The browser bootstrap (`MswInit`) GETs
// this list right after `worker.start()` and replays each descriptor via
// `worker.use(...)`, so a single POST covers both runtimes.

export const dynamic = "force-dynamic";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

type HandlerOverride = {
  method: HttpMethod;
  url: string;
  status?: number;
  body?: unknown;
  once?: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __archestraMswOverrides: HandlerOverride[] | undefined;
}

// Defense in depth: even if NEXT_PUBLIC_API_MOCKING somehow leaks into a
// production-like deployment, NODE_ENV !== "production" keeps the endpoint
// 404. Matching the gate in instrumentation.ts and msw-init.tsx.
const ENABLED =
  process.env.NEXT_PUBLIC_API_MOCKING === "enabled" &&
  process.env.NODE_ENV !== "production";
const BACKEND_ORIGIN =
  process.env.ARCHESTRA_INTERNAL_API_BASE_URL || "http://localhost:9000";

export async function POST(req: Request): Promise<Response> {
  if (!ENABLED) return notFound();

  const override = (await req.json()) as HandlerOverride;
  if (!isValidOverride(override)) {
    return Response.json(
      { error: "invalid_override", override },
      { status: 400 },
    );
  }

  const [msw, { ensureMswServerListening, server }, { buildHandler }] =
    await Promise.all([
      import("msw"),
      import("@/mocks/node"),
      import("@/mocks/build-handler"),
    ]);
  ensureMswServerListening();

  const urls = override.url.startsWith("/")
    ? [override.url, `${BACKEND_ORIGIN}${override.url}`]
    : [override.url];

  server.use(...urls.map((u) => buildHandler(msw, u, override)));

  registry().push(override);

  return Response.json({ ok: true, registered: urls });
}

export async function GET(): Promise<Response> {
  if (!ENABLED) return notFound();
  const { ensureMswServerListening } = await import("@/mocks/node");
  ensureMswServerListening();
  return Response.json({
    overrides: registry(),
    unhandledRequests: globalThis.__archestraUnhandledRequests ?? [],
  });
}

export async function DELETE(): Promise<Response> {
  if (!ENABLED) return notFound();
  const { ensureMswServerListening, server } = await import("@/mocks/node");
  ensureMswServerListening();
  server.resetHandlers();
  globalThis.__archestraMswOverrides = [];
  globalThis.__archestraUnhandledRequests = [];
  return Response.json({ ok: true });
}

function registry(): HandlerOverride[] {
  if (!globalThis.__archestraMswOverrides) {
    globalThis.__archestraMswOverrides = [];
  }
  return globalThis.__archestraMswOverrides;
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function isValidOverride(value: unknown): value is HandlerOverride {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.url === "string" &&
    typeof v.method === "string" &&
    ["get", "post", "put", "patch", "delete"].includes(v.method)
  );
}
