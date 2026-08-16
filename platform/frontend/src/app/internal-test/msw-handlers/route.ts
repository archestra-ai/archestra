// Control endpoint for per-test MSW handler overrides used by Playwright
// integration tests. Gated by NEXT_PUBLIC_API_MOCKING=enabled — returns 404
// outside the test runtime so production deployments cannot register handlers.
//
// Overrides reach two runtimes:
//   - The server-side handler chain read by the mock backend route at
//     `/internal-test/api/[...path]`, which answers SSR fetches.
//   - The browser `setupWorker`, which intercepts client-side fetches.
//
// POST registers on the server side immediately and persists the descriptor in
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
// 404. Matching the gate in the mock backend route and msw-init.tsx.
const ENABLED =
  process.env.NEXT_PUBLIC_API_MOCKING === "enabled" &&
  process.env.NODE_ENV !== "production";

export async function POST(req: Request): Promise<Response> {
  if (!ENABLED) return notFound();

  const override = (await req.json()) as HandlerOverride;
  if (!isValidOverride(override)) {
    return Response.json(
      { error: "invalid_override", override },
      { status: 400 },
    );
  }

  // Imported lazily, past the ENABLED gate, so `msw` — a devDependency —
  // stays out of production bundles.
  const [msw, { buildHandler }, { addOverrideHandler }] = await Promise.all([
    import("msw"),
    import("@/mocks/build-handler"),
    import("@/mocks/resolve"),
  ]);

  // Built once and kept, rather than rebuilt per request: a `once: true`
  // handler tracks on the instance whether it has already been spent.
  addOverrideHandler(buildHandler(msw, override.url, override));
  registry().push(override);

  return Response.json({ ok: true, registered: [override.url] });
}

export async function GET(): Promise<Response> {
  if (!ENABLED) return notFound();
  return Response.json({
    overrides: registry(),
    unhandledRequests: globalThis.__archestraUnhandledRequests ?? [],
  });
}

export async function DELETE(): Promise<Response> {
  if (!ENABLED) return notFound();
  const { clearOverrideHandlers } = await import("@/mocks/resolve");
  clearOverrideHandlers();
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
