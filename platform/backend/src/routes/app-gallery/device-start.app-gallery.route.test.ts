import { vi } from "vitest";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import appGalleryRoutes from "./app-gallery.routes";

// cacheManager (used by the rate limiter) needs a live PostgreSQL connection
// that PGlite tests don't have; back it with the canonical Map-backed fake from
// src/__mocks__/cache-manager.ts (reset before every test).
vi.mock("@/cache-manager");

describe("POST /api/app-gallery/device/start", () => {
  const ctx = useRouteTestApp(appGalleryRoutes);

  beforeEach(() => {
    // This file uses vi.mock, so it runs in the isolated project where config
    // is NOT auto-restored between tests; every case must set the baseline it
    // needs. The override bypasses the hackathon date window so these cases
    // don't depend on the wall clock.
    config.hackathonRecorder.enabled = true;
    config.hackathonRecorder.overrideActive = true;
    config.hackathonRecorder.gallery.githubClientId = "Iv1.test-gallery";
    config.hackathonRecorder.gallery.repo = {
      owner: "archestra-ai",
      name: "app-gallery",
    };
  });

  test("requests a device code from GitHub with the gallery client id and public_repo scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        device_code: "device-123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 899,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-gallery/device/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deviceCode: "device-123",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 899,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://github.com/login/device/code");
    expect(JSON.parse(init.body)).toEqual({
      client_id: "Iv1.test-gallery",
      scope: "public_repo",
    });
  });

  test("maps a GitHub failure to a 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
    );

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-gallery/device/start",
    });

    expect(response.statusCode).toBe(502);
  });

  test("403 when the deployment has no gallery client id configured", async () => {
    config.hackathonRecorder.gallery.githubClientId = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-gallery/device/start",
    });

    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("403 when the recorder feature itself is off", async () => {
    config.hackathonRecorder.enabled = false;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-gallery/device/start",
    });

    expect(response.statusCode).toBe(403);
  });
});
