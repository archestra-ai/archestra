import { vi } from "vitest";

// Isolated from oauth.test.ts (which stays mock-free / fast path) because this
// suite mocks @/logging to observe the warn the initiate handler emits.
vi.mock("@/logging");

import logger from "@/logging";
import { describe, expect, test, useRouteTestApp } from "@/test";
import oauthRoutes from "./oauth";

/**
 * Handled client errors on /api/oauth/initiate are formatted by the centralized
 * error handler but filtered from Sentry, so the handler warns with the
 * catalogId to keep a misconfigured catalog entry visible in logs. Assert that
 * observable via its structured fields, without pinning the log message text.
 */
describe("POST /api/oauth/initiate observability", () => {
  const ctx = useRouteTestApp(oauthRoutes);

  test("warns with catalogId and statusCode when initiate rejects with a client error", async () => {
    const catalogId = "00000000-0000-4000-8000-000000000000";

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: { catalogId },
    });

    expect(response.statusCode, response.body).toBe(404);

    const warned = vi
      .mocked(logger.warn)
      .mock.calls.find(
        ([context]) =>
          (context as { catalogId?: string })?.catalogId === catalogId,
      );
    expect(warned?.[0]).toMatchObject({ catalogId, statusCode: 404 });
  });
});
