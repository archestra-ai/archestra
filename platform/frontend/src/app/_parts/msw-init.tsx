"use client";

import type { SetupWorker } from "msw/browser";
import { useEffect, useState } from "react";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

type HandlerOverride = {
  method: HttpMethod;
  url: string;
  status?: number;
  body?: unknown;
  once?: boolean;
};

declare global {
  interface Window {
    __archestraUnhandledRequests?: string[];
    __archestraSyncMswOverrides?: () => Promise<void>;
  }
}

export function MswInit({ children }: { children: React.ReactNode }) {
  // `process.env.NEXT_PUBLIC_*` is inlined at build time, so in production
  // builds (where the env var is unset) this branch is statically reachable
  // and the dynamic import below is dead code that bundlers can eliminate.
  if (process.env.NEXT_PUBLIC_API_MOCKING !== "enabled") {
    return <>{children}</>;
  }
  return <MswInitInner>{children}</MswInitInner>;
}

function MswInitInner({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ worker }, { isApiRequest }] = await Promise.all([
        import("@/mocks/browser"),
        import("@/mocks/match"),
      ]);
      await worker.start({
        // Strict mode: any unmocked API request is tracked and asserted at
        // test teardown. Non-API requests (Next.js internals, telemetry,
        // fonts, source maps) silently bypass — they aren't the contract
        // these tests verify. See src/mocks/match.ts for the predicate.
        onUnhandledRequest(req) {
          if (!isApiRequest(req.url)) return;
          window.__archestraUnhandledRequests ??= [];
          window.__archestraUnhandledRequests.push(`${req.method} ${req.url}`);
        },
        serviceWorker: { url: "/mockServiceWorker.js" },
      });
      await syncOverrides(worker);
      // Expose a sync entrypoint the Playwright `MswControl` fixture calls
      // after every `use(...)` / `reset()` so late overrides reach the
      // browser worker, not just the Node MSW server. Without this, a test
      // that overrides a response after navigation would see SSR data drift
      // from client-side refetches.
      window.__archestraSyncMswOverrides = () => syncOverrides(worker);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}

async function syncOverrides(worker: SetupWorker): Promise<void> {
  worker.resetHandlers();
  await applyOverridesFromRegistry(worker);
}

async function applyOverridesFromRegistry(worker: SetupWorker): Promise<void> {
  try {
    const res = await fetch("/internal-test/msw-handlers");
    if (!res.ok) return;
    const data = (await res.json()) as { overrides?: HandlerOverride[] };
    const overrides = data.overrides ?? [];
    if (overrides.length === 0) return;

    const [msw, { buildHandler }] = await Promise.all([
      import("msw"),
      import("@/mocks/build-handler"),
    ]);
    // One `worker.use()` per override (not a batched call) so each prepend
    // honors "latest wins" for repeated overrides of the same method+url.
    // A single `worker.use(...handlers)` would keep arg-list order, so the
    // first-registered override would match earlier requests — diverging
    // from the Node side, where one `server.use()` per POST gives the
    // most-recent override priority.
    for (const o of overrides) {
      worker.use(buildHandler(msw, o.url, o));
    }
  } catch {
    // Best effort: if sync fails, the browser falls back to base handlers.
  }
}
