import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import type { JwksValidationResult } from "@/services/jwks-validator";
import { describe, expect, test } from "@/test";

const mockValidateJwt = vi.fn<() => Promise<JwksValidationResult | null>>();
const mockFindExternalIdentityProviderById = vi.fn();
const mockDiscoverOidcJwksUrl = vi.fn();

vi.mock("@/services/jwks-validator", () => ({
  jwksValidator: {
    validateJwt: (...args: unknown[]) => mockValidateJwt(...(args as [])),
  },
}));

vi.mock("@/services/identity-providers/oidc", () => ({
  findExternalIdentityProviderById: (...args: unknown[]) =>
    mockFindExternalIdentityProviderById(...args),
  discoverOidcJwksUrl: (...args: unknown[]) => mockDiscoverOidcJwksUrl(...args),
}));

const {
  MCP_RESOURCE_REFERENCE_PREFIX,
  OAUTH_ID_JAG_TYP,
  exchangeIdentityAssertionForAccessToken,
} = await import("./authorization");

describe("exchangeIdentityAssertionForAccessToken", () => {
  test("returns invalid_scope when assertion does not include mcp scope", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
    makeIdentityProvider,
    makeOAuthClient,
  }) => {
    const user = await makeUser({ email: "member@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "admin" });
    const identityProvider = await makeIdentityProvider(org.id);
    await db
      .update(schema.identityProvidersTable)
      .set({
        issuer: "https://idp.example.com",
        oidcConfig: JSON.stringify({
          issuer: "https://idp.example.com",
          pkce: true,
          clientId: "idp-client",
          clientSecret: "idp-secret",
          discoveryEndpoint:
            "https://idp.example.com/.well-known/openid-configuration",
          jwksEndpoint: "https://idp.example.com/jwks",
        }) as never,
      })
      .where(eq(schema.identityProvidersTable.id, identityProvider.id));
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: identityProvider.id,
    });
    const client = await makeOAuthClient({ userId: user.id });

    mockFindExternalIdentityProviderById.mockResolvedValue({
      id: identityProvider.id,
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "idp-client",
        jwksEndpoint: "https://idp.example.com/jwks",
      },
    });
    mockValidateJwt.mockResolvedValue({
      sub: "subject-1",
      email: user.email,
      name: user.name,
      rawClaims: {},
    });

    const result = await exchangeIdentityAssertionForAccessToken({
      assertion: makeAssertionJwt({
        resource: `http://localhost:3000/v1/mcp/${agent.id}`,
        clientId: client.clientId,
        scope: "email",
      }),
      clientId: client.clientId,
      clientSecret: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid_scope result");
    }
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe("invalid_scope");
  });

  test("returns invalid_client when confidential client secret does not match", async ({
    makeUser,
    makeOAuthClient,
  }) => {
    const user = await makeUser();
    const client = await makeOAuthClient({ userId: user.id });

    await import("@/database").then(async ({ default: db, schema }) => {
      await db
        .update(schema.oauthClientsTable)
        .set({
          public: false,
          clientSecret: "expected-secret",
          tokenEndpointAuthMethod: "client_secret_post",
        })
        .where(eq(schema.oauthClientsTable.clientId, client.clientId));
    });

    const result = await exchangeIdentityAssertionForAccessToken({
      assertion: "not-needed",
      clientId: client.clientId,
      clientSecret: "wrong-secret",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid_client result");
    }
    expect(result.statusCode).toBe(401);
    expect(result.body.error).toBe("invalid_client");
  });

  test("issues a resource-bound OAuth access token for a valid ID-JAG assertion", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
    makeIdentityProvider,
    makeOAuthClient,
  }) => {
    const user = await makeUser({ email: "employee@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "admin" });
    const identityProvider = await makeIdentityProvider(org.id);
    await db
      .update(schema.identityProvidersTable)
      .set({
        issuer: "https://idp.example.com",
        oidcConfig: JSON.stringify({
          issuer: "https://idp.example.com",
          pkce: true,
          clientId: "idp-client",
          clientSecret: "idp-secret",
          discoveryEndpoint:
            "https://idp.example.com/.well-known/openid-configuration",
          jwksEndpoint: "https://idp.example.com/jwks",
        }) as never,
      })
      .where(eq(schema.identityProvidersTable.id, identityProvider.id));
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: identityProvider.id,
    });
    const client = await makeOAuthClient({ userId: user.id });

    mockFindExternalIdentityProviderById.mockResolvedValue({
      id: identityProvider.id,
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "idp-client",
        jwksEndpoint: "https://idp.example.com/jwks",
      },
    });
    mockValidateJwt.mockResolvedValue({
      sub: "subject-1",
      email: user.email,
      name: user.name,
      rawClaims: {},
    });

    const result = await exchangeIdentityAssertionForAccessToken({
      assertion: makeAssertionJwt({
        resource: `http://localhost:3000/v1/mcp/${agent.id}`,
        clientId: client.clientId,
        scope: "mcp email",
      }),
      clientId: client.clientId,
      clientSecret: undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected successful token exchange");
    }
    expect(result.body.token_type).toBe("Bearer");
    expect(result.body.scope).toBe("mcp");

    const tokenHash = createHash("sha256")
      .update(result.body.access_token)
      .digest("base64url");
    const storedToken = await OAuthAccessTokenModel.getByTokenHash(tokenHash);

    expect(storedToken?.userId).toBe(user.id);
    expect(storedToken?.clientId).toBe(client.clientId);
    expect(storedToken?.referenceId).toBe(
      `${MCP_RESOURCE_REFERENCE_PREFIX}${agent.id}`,
    );
  });

  test("rejects assertions whose resource URL points at a different host", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
    makeIdentityProvider,
    makeOAuthClient,
  }) => {
    const user = await makeUser({ email: "employee@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "admin" });
    const identityProvider = await makeIdentityProvider(org.id);
    await db
      .update(schema.identityProvidersTable)
      .set({
        issuer: "https://idp.example.com",
        oidcConfig: JSON.stringify({
          issuer: "https://idp.example.com",
          clientId: "idp-client",
          jwksEndpoint: "https://idp.example.com/jwks",
        }) as never,
      })
      .where(eq(schema.identityProvidersTable.id, identityProvider.id));
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: identityProvider.id,
    });
    const client = await makeOAuthClient({ userId: user.id });

    mockFindExternalIdentityProviderById.mockResolvedValue({
      id: identityProvider.id,
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "idp-client",
        jwksEndpoint: "https://idp.example.com/jwks",
      },
    });
    mockValidateJwt.mockResolvedValue({
      sub: "subject-1",
      email: user.email,
      name: user.name,
      rawClaims: {},
    });

    const result = await exchangeIdentityAssertionForAccessToken({
      assertion: makeAssertionJwt({
        resource: `https://attacker.example.com/v1/mcp/${agent.id}`,
        clientId: client.clientId,
        scope: "mcp email",
      }),
      clientId: client.clientId,
      clientSecret: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid_grant result");
    }
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
  });
});

function makeAssertionJwt(params: {
  resource: string;
  clientId: string;
  scope: string;
}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: OAUTH_ID_JAG_TYP }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://idp.example.com",
      sub: "subject-1",
      aud: "http://localhost:3000/",
      resource: params.resource,
      client_id: params.clientId,
      scope: params.scope,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
      email: "employee@example.com",
    }),
  ).toString("base64url");

  return `${header}.${payload}.signature`;
}
