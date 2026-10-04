import {
  getRedirectUrl,
  unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  withSentryConfig: (config: unknown) => config,
}));

describe("next config rewrites", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ARCHESTRA_INTERNAL_API_BASE_URL;
    delete process.env.VERSION;
  });

  it("uses sanitized VERSION as the deployment id", async () => {
    process.env.VERSION = "v1.2.41+build.5";

    const { default: nextConfig } = await import("../next.config");

    expect(nextConfig.deploymentId).toBe("v1-2-41-build-5");
  });

  it("proxies well-known oauth discovery routes to the backend by default", async () => {
    const { default: nextConfig } = await import("../next.config");

    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/.well-known/:path*",
          destination: "http://127.0.0.1:9000/.well-known/:path*",
        },
      ]),
    );
  });

  it("proxies every versioned API prefix the backend serves", async () => {
    const { default: nextConfig } = await import("../next.config");

    const rewrites = await nextConfig.rewrites?.();

    // A missing prefix is not a 502 the caller can read — Next answers it from
    // the app router, so a JSON client gets the HTML 404 page. /v2 carries the
    // A2A surface (`/v2/a2a/*`).
    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/v1/:path*",
          destination: "http://127.0.0.1:9000/v1/:path*",
        },
        {
          source: "/v2/:path*",
          destination: "http://127.0.0.1:9000/v2/:path*",
        },
      ]),
    );
  });

  it("uses the configured backend URL for well-known oauth discovery routes", async () => {
    process.env.ARCHESTRA_INTERNAL_API_BASE_URL = "https://api.example.com";

    const { default: nextConfig } = await import("../next.config");

    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/.well-known/:path*",
          destination: "https://api.example.com/.well-known/:path*",
        },
      ]),
    );
  });
});

it.each([
  "/settings/credentials/github/callback",
  "/account/connections/github/callback",
])("forwards %s to the shared callback without losing OAuth parameters", async (path) => {
  const { default: nextConfig } = await import("../next.config");
  const response = await unstable_getResponseFromNextConfig({
    url: `https://app.example.com${path}?code=synthetic%2Bcode&state=synthetic%2Fstate`,
    nextConfig,
  });
  expect(response.status).toBe(307);
  const target = new URL(getRedirectUrl(response) ?? "");
  expect(target.origin).toBe("https://app.example.com");
  expect(target.pathname).toBe("/github/callback");
  expect(target.searchParams.get("code")).toBe("synthetic+code");
  expect(target.searchParams.get("state")).toBe("synthetic/state");
});
