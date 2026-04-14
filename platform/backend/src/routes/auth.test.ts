import { createHash } from "node:crypto";
import { IDENTITY_PROVIDER_ID } from "@shared";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import config from "@/config";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import OrganizationModel from "@/models/organization";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

vi.mock("@/auth", () => ({
  betterAuth: {
    handler: vi.fn(),
  },
}));

describe("auth routes", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    app = createFastifyInstance();
    const { default: authRoutes } = await import("./auth");
    await app.register(authRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("applies organization MCP token lifetime to OAuth 2.1 token responses", async ({
    makeAgent,
    makeOAuthAccessToken,
    makeOAuthClient,
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      mcpOauthAccessTokenLifetimeSeconds: 604_800,
    });
    const agent = await makeAgent({ organizationId: organization.id });
    const client = await makeOAuthClient({ userId: user.id });
    const rawAccessToken = "standard-oauth-access-token";
    const tokenHash = createHash("sha256")
      .update(rawAccessToken)
      .digest("base64url");
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: tokenHash,
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    });
    const issuedAtSeconds = 1_767_225_600;
    const betterAuthHandler = vi.mocked(betterAuth.handler);
    betterAuthHandler.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: rawAccessToken,
          token_type: "Bearer",
          expires_in: 3_600,
          expires_at: issuedAtSeconds + 3_600,
          scope: "mcp",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      payload: {
        grant_type: "authorization_code",
        client_id: client.clientId,
        code: "auth-code",
        resource: `http://localhost:3000/v1/mcp/${agent.id}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      access_token: rawAccessToken,
      expires_in: 604_800,
      expires_at: issuedAtSeconds + 604_800,
    });

    const forwardedRequest = betterAuthHandler.mock.calls[0]?.[0] as Request;
    expect(await forwardedRequest.clone().json()).not.toHaveProperty(
      "resource",
    );

    const storedToken = await OAuthAccessTokenModel.getByTokenHash(tokenHash);
    expect(storedToken?.expiresAt).toEqual(
      new Date((issuedAtSeconds + 604_800) * 1000),
    );
  });

  test("applies MCP token lifetime when resource uses the token endpoint origin", async ({
    makeAgent,
    makeOAuthAccessToken,
    makeOAuthClient,
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      mcpOauthAccessTokenLifetimeSeconds: 31_536_000,
    });
    const agent = await makeAgent({ organizationId: organization.id });
    const client = await makeOAuthClient({ userId: user.id });
    const rawAccessToken = "inspector-oauth-access-token";
    const tokenHash = createHash("sha256")
      .update(rawAccessToken)
      .digest("base64url");
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: tokenHash,
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    });
    vi.mocked(betterAuth.handler).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: rawAccessToken,
          token_type: "Bearer",
          expires_in: 3_600,
          scope: "mcp",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: {
        host: "localhost:9000",
      },
      payload: {
        grant_type: "authorization_code",
        client_id: client.clientId,
        code: "auth-code",
        resource: `http://localhost:9000/v1/mcp/${agent.id}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      access_token: rawAccessToken,
      expires_in: 31_536_000,
    });
  });

  test("applies MCP token lifetime for HTTPS token endpoint origin behind proxy", async ({
    makeAgent,
    makeOAuthAccessToken,
    makeOAuthClient,
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      mcpOauthAccessTokenLifetimeSeconds: 31_536_000,
    });
    const agent = await makeAgent({ organizationId: organization.id });
    const client = await makeOAuthClient({ userId: user.id });
    const rawAccessToken = "https-inspector-oauth-access-token";
    const tokenHash = createHash("sha256")
      .update(rawAccessToken)
      .digest("base64url");
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: tokenHash,
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    });
    vi.mocked(betterAuth.handler).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: rawAccessToken,
          token_type: "Bearer",
          expires_in: 3_600,
          scope: "mcp",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: {
        host: "backend.example.com",
        "x-forwarded-proto": "https",
      },
      payload: {
        grant_type: "authorization_code",
        client_id: client.clientId,
        code: "auth-code",
        resource: `https://backend.example.com/v1/mcp/${agent.id}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      access_token: rawAccessToken,
      expires_in: 31_536_000,
    });
  });

  test("applies MCP token lifetime when resource uses the gateway slug", async ({
    makeAgent,
    makeOAuthAccessToken,
    makeOAuthClient,
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      mcpOauthAccessTokenLifetimeSeconds: 300,
    });
    const agent = await makeAgent({
      agentType: "mcp_gateway",
      name: "Default MCP Gateway",
      organizationId: organization.id,
    });
    const client = await makeOAuthClient({ userId: user.id });
    const rawAccessToken = "cursor-oauth-access-token";
    const tokenHash = createHash("sha256")
      .update(rawAccessToken)
      .digest("base64url");
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: tokenHash,
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    });
    const issuedAtSeconds = 1_767_225_600;
    vi.mocked(betterAuth.handler).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: rawAccessToken,
          token_type: "Bearer",
          expires_in: 3_600,
          expires_at: issuedAtSeconds + 3_600,
          scope: "mcp",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: {
        host: "localhost:9000",
      },
      payload: {
        grant_type: "authorization_code",
        client_id: client.clientId,
        code: "auth-code",
        resource: `http://localhost:9000/v1/mcp/${agent.slug}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      access_token: rawAccessToken,
      expires_in: 300,
      expires_at: issuedAtSeconds + 300,
    });

    const storedToken = await OAuthAccessTokenModel.getByTokenHash(tokenHash);
    expect(storedToken?.expiresAt).toEqual(
      new Date((issuedAtSeconds + 300) * 1000),
    );
  });

  test("adds the configured Google hosted domain hint to SSO sign-in URLs", async ({
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const originalEnterpriseValue = config.enterpriseFeatures.core;
    Object.defineProperty(config.enterpriseFeatures, "core", {
      value: true,
      writable: true,
      configurable: true,
    });

    const organization = await makeOrganization();
    const admin = await makeUser();

    try {
      await makeIdentityProvider(organization.id, {
        userId: admin.id,
        providerId: IDENTITY_PROVIDER_ID.GOOGLE,
        issuer: "https://accounts.google.com",
        oidcConfig: {
          issuer: "https://accounts.google.com",
          pkce: true,
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
          discoveryEndpoint:
            "https://accounts.google.com/.well-known/openid-configuration",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          jwksEndpoint: "https://www.googleapis.com/oauth2/v3/certs",
          userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
          hd: "example.com",
          mapping: { id: "sub", email: "email", name: "name" },
        },
      });

      vi.mocked(betterAuth.handler).mockResolvedValue(
        new Response(
          JSON.stringify({
            url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=google-client-id",
            redirect: true,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              location:
                "https://accounts.google.com/o/oauth2/v2/auth?client_id=google-client-id",
            },
          },
        ),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/sso",
        payload: {
          providerId: IDENTITY_PROVIDER_ID.GOOGLE,
          callbackURL: "http://localhost:3000/",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=google-client-id&hd=example.com",
        redirect: true,
      });
      expect(response.headers.location).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=google-client-id&hd=example.com",
      );
    } finally {
      Object.defineProperty(config.enterpriseFeatures, "core", {
        value: originalEnterpriseValue,
        writable: true,
        configurable: true,
      });
    }
  });
});
