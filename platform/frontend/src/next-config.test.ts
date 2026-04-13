import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  withSentryConfig: (config: unknown) => config,
}));

describe("next config rewrites", () => {
  beforeEach(() => {
    delete process.env.ARCHESTRA_INTERNAL_API_BASE_URL;
  });

  it("proxies well-known oauth discovery routes to the backend by default", async () => {
    const { default: nextConfig } = await import("../next.config");

    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/.well-known/:path*",
          destination: "http://localhost:9000/.well-known/:path*",
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
