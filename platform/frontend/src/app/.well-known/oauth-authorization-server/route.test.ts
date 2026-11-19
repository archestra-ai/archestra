import { NextRequest } from "next/server";
import { afterEach, expect, test, vi } from "vitest";

import { GET } from "./route";

afterEach(() => vi.unstubAllGlobals());

test.each([
  "localhost:3300",
  "127.0.0.1:3300",
  "stack2.localhost:3300",
])("issuer discovery preserves public authority %s for backend validation", async (host) => {
  vi.stubEnv("ARCHESTRA_INTERNAL_API_BASE_URL", "http://127.0.0.1:9000");
  vi.stubEnv(
    "NEXT_PUBLIC_ARCHESTRA_INTERNAL_API_BASE_URL",
    "http://stack2.localhost:9300",
  );
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ issuer: `http://${host}` }), {
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const response = await GET(
    new NextRequest(`http://${host}/.well-known/oauth-authorization-server`, {
      headers: {
        host,
        "x-forwarded-host": "untrusted.example",
        "x-forwarded-proto": "https",
      },
    }),
  );
  expect(fetcher).toHaveBeenCalledWith(
    new URL("http://127.0.0.1:9000/.well-known/oauth-authorization-server"),
    expect.objectContaining({
      headers: { "X-Forwarded-Host": host, "X-Forwarded-Proto": "http" },
      redirect: "error",
      cache: "no-store",
    }),
  );
  expect(await response.json()).toEqual({ issuer: `http://${host}` });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("issuer discovery preserves backend rejection instead of admitting an untrusted host", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 400 })),
  );
  const response = await GET(
    new NextRequest(
      "http://untrusted.example/.well-known/oauth-authorization-server",
    ),
  );
  expect(response.status).toBe(400);
});
