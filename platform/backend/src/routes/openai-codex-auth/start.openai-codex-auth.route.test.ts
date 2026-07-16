import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// cacheManager (used by the rate limiter) needs a live PostgreSQL connection
// PGlite tests don't have; back it with the canonical Map-backed fake.
vi.mock("@/cache-manager");

// Pin the codex OAuth config so a developer's local .env can't leak into the
// asserted URLs/body.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      openai: {
        codex: {
          issuer: "https://auth.openai.com",
          clientId: "app_test_client",
          originator: "codex_cli_rs",
          apiBaseUrl: "https://chatgpt.com/backend-api/codex",
        },
      },
    },
  }),
);

describe("POST /api/openai-codex-auth/device/start", () => {
  let app: FastifyInstanceWithZod;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organization.id;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: openaiCodexAuthRoutes } = await import(
      "./openai-codex-auth.routes"
    );
    await app.register(openaiCodexAuthRoutes);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  test("requests a device code from OpenAI and returns the poll handle", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        device_auth_id: "dev-auth-1",
        user_code: "WXYZ-9876",
        interval: 5,
        expires_in: 899,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      method: "POST",
      url: "/api/openai-codex-auth/device/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deviceAuthId: "dev-auth-1",
      userCode: "WXYZ-9876",
      verificationUri: "https://auth.openai.com/codex/device",
      interval: 5,
      expiresIn: 899,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
    );
    // The device endpoint takes ONLY the client id (matching the Codex CLI).
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "app_test_client",
    });
  });

  test("accepts the `usercode` alias and a string interval", async () => {
    // The real device endpoint returns the code under `usercode` and sends
    // `interval` as a string — the exact shape that previously failed to parse.
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        device_auth_id: "dev-auth-2",
        usercode: "ABCD-1234",
        interval: "5",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      method: "POST",
      url: "/api/openai-codex-auth/device/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deviceAuthId: "dev-auth-2",
      userCode: "ABCD-1234",
      verificationUri: "https://auth.openai.com/codex/device",
      interval: 5,
      expiresIn: 900,
    });
  });

  test("maps a disabled-device-code 404 to an actionable 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/openai-codex-auth/device/start",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/device code/i);
  });

  test("maps an OpenAI failure to a 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/openai-codex-auth/device/start",
    });

    expect(response.statusCode).toBe(502);
  });
});
