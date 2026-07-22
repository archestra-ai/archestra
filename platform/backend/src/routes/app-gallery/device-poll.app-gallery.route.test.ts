import { vi } from "vitest";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import appGalleryRoutes from "./app-gallery.routes";

// cacheManager (used by the rate limiter) needs a live PostgreSQL connection
// that PGlite tests don't have; back it with the canonical Map-backed fake from
// src/__mocks__/cache-manager.ts (reset before every test).
vi.mock("@/cache-manager");

describe("POST /api/app-gallery/device/poll", () => {
  const ctx = useRouteTestApp(appGalleryRoutes);

  beforeEach(() => {
    // Isolated project (vi.mock in this file): config is not auto-restored,
    // so every flag the routes read is set here. The override bypasses the
    // hackathon date window so these cases don't depend on the wall clock.
    config.hackathonRecorder.enabled = true;
    config.hackathonRecorder.overrideActive = true;
    config.hackathonRecorder.gallery.githubClientId = "Iv1.test-gallery";
    config.hackathonRecorder.gallery.repo = {
      owner: "archestra-ai",
      name: "app-gallery",
    };
  });

  function poll() {
    return ctx.app.inject({
      method: "POST",
      url: "/api/app-gallery/device/poll",
      payload: { deviceCode: "device-123" },
    });
  }

  test("returns the token once GitHub reports the participant authorized", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ access_token: "gho_test-token" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await poll();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "complete",
      accessToken: "gho_test-token",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(init.body)).toEqual({
      client_id: "Iv1.test-gallery",
      device_code: "device-123",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  test.each([
    ["authorization_pending", "pending"],
    ["slow_down", "slow_down"],
  ] as const)("relays GitHub's %s as status %s", async (error, status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error })));

    const response = await poll();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status });
  });

  test.each([
    "expired_token",
    "access_denied",
  ])("maps GitHub's terminal %s to a 400", async (error) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error })));

    const response = await poll();

    expect(response.statusCode).toBe(400);
  });

  test("maps a GitHub failure to a 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
    );

    const response = await poll();

    expect(response.statusCode).toBe(502);
  });

  test("403 when the deployment has no gallery repository configured", async () => {
    config.hackathonRecorder.gallery.repo = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await poll();

    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
