import type { RequestHandler } from "msw";
import { setupServer } from "msw/node";
import { afterEach, beforeEach } from "vitest";

/**
 * Boundary-mock HTTP for a test file with MSW. Intercepts axios, global
 * fetch, and undici alike — use this instead of `vi.mock`-ing an HTTP client
 * module (jira.js, @gitbeaker/rest, openai, ...): the real client runs and
 * only the network is faked, and a file whose last `vi.mock` disappears
 * automatically joins the fast (shared-worker) vitest project.
 *
 * ```ts
 * import { http, HttpResponse } from "msw";
 * import { useMswServer } from "@/test/msw";
 *
 * const server = useMswServer(); // or with default handlers
 * test("...", async () => {
 *   server.use(
 *     http.get("https://example.atlassian.net/rest/api/3/search/jql", () =>
 *       HttpResponse.json({ issues: [] }),
 *     ),
 *   );
 *   // exercise the real client
 * });
 * ```
 *
 * Lifecycle is per TEST, not per file: the shared setup restores the real
 * `globalThis.fetch` after every test (leak protection), which would strip a
 * beforeAll-installed fetch interceptor for the rest of the file. Listening
 * in beforeEach re-patches after that restore; closing in afterEach runs
 * before the setup's restore (file hooks run first), so teardown never
 * leaves a half-patched state — in shared workers a leaked interceptor
 * would poison every later file.
 *
 * Unhandled requests fail the test (`onUnhandledRequest: "error"`), so a
 * missing handler is a loud failure instead of a live network call.
 */
export function useMswServer(
  ...defaultHandlers: RequestHandler[]
): ReturnType<typeof setupServer> {
  const server = setupServer(...defaultHandlers);

  beforeEach(() => {
    server.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    server.resetHandlers();
    server.close();
  });

  return server;
}
