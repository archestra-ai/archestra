// Resolves a request against the mock handler chain directly, without any
// network interception.
//
// The browser half of the harness runs MSW as a service worker, which is
// reliable. The server half used to run `setupServer()` inside the Next.js dev
// process and depend on its global `fetch`/http patches surviving every
// on-demand route compile. They did not always survive, and a server component
// whose fetch escaped the patch silently fell through to the unreachable
// backend origin — which surfaced as a wrong-looking page rather than an
// error. Server-side mocking now goes over real HTTP to the catch-all route at
// `/internal-test/api/[...path]`, which calls into this module. Nothing global
// is patched, so nothing can be un-patched.

import type { DefaultBodyType, HttpHandler, StrictRequest } from "msw";
import { handlers } from "./handlers";

declare global {
  // eslint-disable-next-line no-var
  var __archestraMswOverrideHandlers: HttpHandler[] | undefined;
}

export function addOverrideHandler(handler: HttpHandler): void {
  // Unshift, not push: a later override of the same method+url must win, which
  // mirrors how `worker.use()` prepends on the browser side.
  overrideHandlers().unshift(handler);
}

export function clearOverrideHandlers(): void {
  globalThis.__archestraMswOverrideHandlers = [];
}

/**
 * Run `request` through the override chain and then the base handlers.
 * Returns `null` when nothing matched, which the caller reports as a coverage
 * gap rather than quietly proxying to a real backend.
 */
export async function resolveMockResponse(
  request: Request,
): Promise<Response | null> {
  // Handlers are registered under bare paths, which MSW only resolves against
  // `location.href` — absent outside the browser. Without an explicit base the
  // pattern stays relative and never matches this absolute request URL.
  const resolutionContext = { baseUrl: new URL(request.url).origin };

  for (const handler of [...overrideHandlers(), ...handlers]) {
    // A fresh clone per handler: a resolver that reads the body would
    // otherwise leave it consumed for every handler after it.
    const result = await handler.run({
      request: request.clone() as StrictRequest<DefaultBodyType>,
      requestId: crypto.randomUUID(),
      resolutionContext,
    });
    // `run()` returns null for a non-match and for a spent `once` handler.
    if (result?.response) return result.response;
  }
  return null;
}

/** Per-test override handlers, most recently registered first. */
function overrideHandlers(): HttpHandler[] {
  globalThis.__archestraMswOverrideHandlers ??= [];
  return globalThis.__archestraMswOverrideHandlers;
}
