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
    __archestraApplyMswOverride?: (override: HandlerOverride) => Promise<void>;
    __archestraResetMswOverrides?: () => void;
  }
}

const MSW_ENABLED =
  process.env.NEXT_PUBLIC_API_MOCKING === "enabled" &&
  process.env.NODE_ENV !== "production";

export function MswInit({ children }: { children: React.ReactNode }) {
  // Inlining the guard means the dynamic import below is dead code in
  // production bundles, so MSW is fully tree-shaken.
  if (!MSW_ENABLED) {
    return <>{children}</>;
  }
  return <MswInitInner>{children}</MswInitInner>;
}

// Singleton: React strict mode double-invokes the mount effect, and two
// concurrent worker.start() calls make the loser throw "cannot configure an
// already enabled network" — skipping the registry replay, so the app could
// mount with base handlers while the test's overrides were still pending.
// Both effect runs must await the same end-to-end initialization instead.
let mswInitPromise: Promise<void> | null = null;

function initMswOnce(): Promise<void> {
  mswInitPromise ??= (async () => {
    const [{ worker }, { isApiRequest }, msw, { buildHandler }] =
      await Promise.all([
        import("@/mocks/browser"),
        import("@/mocks/match"),
        import("msw"),
        import("@/mocks/build-handler"),
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
    await applyOverridesFromRegistry(worker, msw, buildHandler);
    // The Playwright `MswControl` fixture calls these after every
    // use(...) / reset(). Apply pushes a single handler — no
    // reset-and-replay, because that would resurrect `once: true`
    // handlers MSW had already consumed.
    window.__archestraApplyMswOverride = async (override) => {
      worker.use(buildHandler(msw, override.url, override));
    };
    window.__archestraResetMswOverrides = () => {
      worker.resetHandlers();
    };
  })();
  return mswInitPromise;
}

function MswInitInner({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initMswOnce();
      } catch (e) {
        // Surface the failure loudly so the test harness sees it. Without
        // this, a service-worker registration error would leave the page in
        // an indefinite "rendering null" state and the test would only fail
        // with an opaque timeout. We still set ready=true below so the rest
        // of the page mounts and tests fail on real assertions plus this
        // console.error breadcrumb, which is far more actionable.
        console.error("[MswInit] worker.start() failed:", e);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}

async function applyOverridesFromRegistry(
  worker: SetupWorker,
  msw: typeof import("msw"),
  buildHandler: typeof import("@/mocks/build-handler").buildHandler,
): Promise<void> {
  try {
    const res = await fetch("/internal-test/msw-handlers");
    if (!res.ok) return;
    const data = (await res.json()) as { overrides?: HandlerOverride[] };
    const overrides = data.overrides ?? [];
    if (overrides.length === 0) return;

    // One `worker.use()` per override so each prepend honors "latest wins"
    // for repeated overrides of the same method+url. A single
    // `worker.use(...handlers)` would keep arg-list order, so the
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
