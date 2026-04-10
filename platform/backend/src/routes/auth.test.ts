import { createHash } from "node:crypto";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
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
});
