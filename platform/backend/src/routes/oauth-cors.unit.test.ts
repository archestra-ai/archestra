import fastifyCors from "@fastify/cors";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import {
  createOAuthAwareCorsDelegate,
  isOAuthAuthorizePath,
  isPublicOAuthCorsPath,
} from "./oauth-cors";

describe("isPublicOAuthCorsPath", () => {
  test.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/v1/mcp/my-gateway-admin-074e96",
    "/.well-known/oauth-authorization-server",
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/token?grant_type=authorization_code",
    "/api/auth/oauth2/register",
    "/api/auth/jwks",
  ])("treats %s as a public OAuth endpoint", (url) => {
    expect(isPublicOAuthCorsPath(url)).toBe(true);
  });

  test.each([
    // Browser-facing, cookie-backed — not a public OAuth endpoint (authorize
    // gets its own CORS-disabled policy; consent stays restricted).
    "/api/auth/oauth2/authorize",
    "/api/auth/oauth2/consent",
    // Unrelated routes.
    "/v1/mcp/my-gateway-admin-074e96",
    "/api/agents",
    "/.well-known/acme-challenge/abc",
    // Near-misses that must not match by prefix.
    "/api/auth/jwks-internal",
    "/api/auth/oauth2/tokenizer",
  ])("treats %s as a restricted endpoint", (url) => {
    expect(isPublicOAuthCorsPath(url)).toBe(false);
  });
});

describe("isOAuthAuthorizePath", () => {
  test.each([
    "/api/auth/oauth2/authorize",
    "/api/auth/oauth2/authorize?client_id=abc&scope=mcp",
  ])("treats %s as the authorize endpoint", (url) => {
    expect(isOAuthAuthorizePath(url)).toBe(true);
  });

  test.each([
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/consent",
    "/api/auth/oauth2/authorization", // near-miss, must not match by prefix
    "/api/agents",
  ])("does not treat %s as the authorize endpoint", (url) => {
    expect(isOAuthAuthorizePath(url)).toBe(false);
  });
});

describe("createOAuthAwareCorsDelegate (wired into @fastify/cors)", () => {
  const RESTRICTED_ORIGIN = "http://localhost:3000";
  const FOREIGN_ORIGIN = "http://localhost:6274"; // e.g. MCP Inspector

  const buildApp = async () => {
    const app = Fastify();
    await app.register(
      fastifyCors,
      createOAuthAwareCorsDelegate({
        restricted: { origin: [RESTRICTED_ORIGIN], credentials: true },
        publicOAuth: { origin: true, credentials: false },
        authorizeDisabled: { origin: false },
      }),
    );
    app.get("/api/auth/jwks", async () => ({ keys: [] }));
    app.post("/api/auth/oauth2/token", async () => ({ ok: true }));
    app.get("/api/auth/oauth2/authorize", async () => ({ ok: true }));
    app.get("/api/agents", async () => ({ ok: true }));
    return app;
  };

  test("reflects an arbitrary origin on a public OAuth endpoint", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/oauth2/token",
      headers: {
        origin: FOREIGN_ORIGIN,
        "access-control-request-method": "POST",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBe(
      FOREIGN_ORIGIN,
    );
    // Public policy is credential-less, so no allow-credentials is advertised.
    expect(
      response.headers["access-control-allow-credentials"],
    ).toBeUndefined();
    await app.close();
  });

  test("blocks an unlisted origin on a non-OAuth endpoint", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/agents",
      headers: {
        origin: FOREIGN_ORIGIN,
        "access-control-request-method": "GET",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  test("still allows the configured origin on a non-OAuth endpoint", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/agents",
      headers: {
        origin: RESTRICTED_ORIGIN,
        "access-control-request-method": "GET",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBe(
      RESTRICTED_ORIGIN,
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });

  test.each([
    FOREIGN_ORIGIN,
    RESTRICTED_ORIGIN,
  ])("disables CORS on the authorize endpoint (no allow-origin) for origin %s", async (origin) => {
    const app = await buildApp();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/oauth2/authorize?client_id=abc",
      headers: { origin, "access-control-request-method": "GET" },
    });
    // CORS is disabled: even the configured origin gets no allow-origin
    // header, so the browser blocks any cross-origin fetch. Top-level
    // navigation is not subject to CORS, so the flow itself is unaffected.
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(
      response.headers["access-control-allow-credentials"],
    ).toBeUndefined();
    await app.close();
  });
});
