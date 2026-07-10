import { vi } from "vitest";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// cacheManager (used by the rate limiter) needs a live PostgreSQL connection
// that PGlite tests don't have; back it with the canonical Map-backed fake from
// src/__mocks__/cache-manager.ts (reset before every test).
vi.mock("@/cache-manager");

// There is no community client id for the Entra device flow, so the config
// default is empty; the routes 400 without one. Give the tests a configured id,
// and pin the tenant/auth host so a developer's local .env (which the test
// setup loads) can't leak into the asserted Entra URLs.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      "microsoft-365-copilot": {
        clientId: "test-entra-client-id",
        tenantId: "organizations",
        authBaseUrl: "https://login.microsoftonline.com",
      },
    },
  }),
);

describe("POST /api/microsoft-365-copilot-auth/device/start", () => {
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

    const { default: microsoft365CopilotAuthRoutes } = await import(
      "./microsoft-365-copilot-auth.routes"
    );
    await app.register(microsoft365CopilotAuthRoutes);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  test("requests a device code from Entra with a form-encoded body and the Graph scopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        device_code: "device-123",
        user_code: "ABCD-1234",
        verification_uri: "https://microsoft.com/devicelogin",
        interval: 5,
        expires_in: 899,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      method: "POST",
      url: "/api/microsoft-365-copilot-auth/device/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deviceCode: "device-123",
      userCode: "ABCD-1234",
      verificationUri: "https://microsoft.com/devicelogin",
      interval: 5,
      expiresIn: 899,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode",
    );
    expect(init.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = init.body as URLSearchParams;
    expect(body.get("client_id")).toBe("test-entra-client-id");
    expect(body.get("scope")).toContain("offline_access");
    expect(body.get("scope")).toContain(
      "https://graph.microsoft.com/Sites.Read.All",
    );
  });

  test("400s with setup guidance when no client id is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const originalClientId = config.llm["microsoft-365-copilot"].clientId;
    config.llm["microsoft-365-copilot"].clientId = "";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/microsoft-365-copilot-auth/device/start",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "ARCHESTRA_MICROSOFT_365_COPILOT_CLIENT_ID",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      config.llm["microsoft-365-copilot"].clientId = originalClientId;
    }
  });

  test("maps an Entra failure to a 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/microsoft-365-copilot-auth/device/start",
    });

    expect(response.statusCode).toBe(502);
  });
});
