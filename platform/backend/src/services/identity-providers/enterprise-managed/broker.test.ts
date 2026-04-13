import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { resolveEnterpriseTransportCredential } from "./broker";

describe("resolveEnterpriseTransportCredential", () => {
  test("exchanges a session IdP token for a managed secret and builds an authorization header", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser({ email: "enterprise-managed@example.com" });
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "okta-enterprise",
      issuer: "https://example.okta.com",
      oidcConfig: {
        clientId: "web-client-id",
        tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
        enterpriseManagedCredentials: {
          providerType: "okta",
          clientId: "ai-agent-client-id",
          tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
          tokenEndpointAuthentication: "client_secret_post",
          clientSecret: "ai-agent-client-secret",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-1",
      providerId: identityProvider.providerId,
      userId: user.id,
      idToken: createJwt({ exp: futureExpSeconds(300) }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          issued_token_type: "urn:okta:params:oauth:token-type:secret",
          secret: { token: "ghu_managed_token" },
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await resolveEnterpriseTransportCredential({
      agentId: agent.id,
      tokenAuth: {
        tokenId: "session-token",
        teamId: null,
        isOrganizationToken: false,
        userId: user.id,
      },
      enterpriseManagedConfig: {
        requestedCredentialType: "secret",
        resourceIdentifier: "orn:okta:pam:github-secret",
        tokenInjectionMode: "authorization_bearer",
        responseFieldPath: "token",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer ghu_managed_token",
      expiresInSeconds: 300,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.okta.com/oauth2/v1/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(
          "requested_token_type=urn%3Aokta%3Aparams%3Aoauth%3Atoken-type%3Asecret",
        ),
      }),
    );

    fetchMock.mockRestore();
  });

  test("uses the caller-provided external IdP token when available", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "okta-external",
      issuer: "https://example.okta.com",
      oidcConfig: {
        clientId: "web-client-id",
        tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
        enterpriseManagedCredentials: {
          providerType: "okta",
          clientId: "ai-agent-client-id",
          tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
          tokenEndpointAuthentication: "client_secret_post",
          clientSecret: "ai-agent-client-secret",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "id-jag-value",
          issued_token_type: "urn:ietf:params:oauth:token-type:id-jag",
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await resolveEnterpriseTransportCredential({
      agentId: agent.id,
      tokenAuth: {
        tokenId: "external-token",
        teamId: null,
        isOrganizationToken: false,
        userId: "user-1",
        isExternalIdp: true,
        rawToken: "external-id-token",
      },
      enterpriseManagedConfig: {
        requestedCredentialType: "id_jag",
        resourceIdentifier: "mcp-resource:gateway-1",
        tokenInjectionMode: "raw_authorization",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "id-jag-value",
      expiresInSeconds: 300,
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "subject_token=external-id-token",
    );

    fetchMock.mockRestore();
  });

  test("exchanges caller-provided ID-JAG at an OAuth protected resource", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "id-jag-demo-idp",
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "gateway-client",
        tokenEndpoint: "https://idp.example.com/token",
        enterpriseManagedCredentials: {
          clientId: "resource-client",
          tokenEndpointAuthentication: "client_secret_basic",
          clientSecret: "resource-secret",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (
          url ===
          "https://resource.example.com/.well-known/oauth-protected-resource/mcp"
        ) {
          return new Response(
            JSON.stringify({
              resource: "https://resource.example.com/mcp",
              authorization_servers: ["https://resource.example.com"],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (
          url ===
          "https://resource.example.com/.well-known/oauth-authorization-server"
        ) {
          return new Response(
            JSON.stringify({
              issuer: "https://resource.example.com",
              token_endpoint: "https://resource.example.com/token",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url === "https://resource.example.com/token") {
          return new Response(
            JSON.stringify({
              access_token: "mcp-server-access-token",
              issued_token_type:
                "urn:ietf:params:oauth:token-type:access_token",
              expires_in: 300,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      });

    const result = await resolveEnterpriseTransportCredential({
      agentId: agent.id,
      tokenAuth: {
        tokenId: "external-id-jag",
        teamId: null,
        isOrganizationToken: false,
        userId: "user-1",
        isExternalIdp: true,
        rawToken: "caller-id-jag",
      },
      enterpriseManagedConfig: {
        requestedCredentialType: "id_jag",
        resourceType: "oauth_protected_resource",
        resourceIdentifier: "https://resource.example.com/mcp",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer mcp-server-access-token",
      expiresInSeconds: 300,
    });

    const tokenRequest = fetchMock.mock.calls.find(
      ([input]) => String(input) === "https://resource.example.com/token",
    );
    expect(String(tokenRequest?.[1]?.body)).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
    );
    expect(String(tokenRequest?.[1]?.body)).toContain(
      "assertion=caller-id-jag",
    );
    const tokenRequestHeaders = tokenRequest?.[1]?.headers as
      | Headers
      | undefined;
    expect(tokenRequestHeaders?.get("authorization")).toBe(
      `Basic ${Buffer.from("resource-client:resource-secret").toString("base64")}`,
    );

    fetchMock.mockRestore();
  });

  test("exchanges a Keycloak session access token for a brokered downstream bearer token", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser({ email: "keycloak-broker@example.com" });
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "keycloak-broker",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        enterpriseManagedCredentials: {
          providerType: "keycloak",
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          tokenEndpoint:
            "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-keycloak",
      providerId: identityProvider.providerId,
      userId: user.id,
      accessToken: "keycloak-session-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 300_000),
      idToken: "keycloak-session-id-token",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "github-mock-access-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await resolveEnterpriseTransportCredential({
      agentId: agent.id,
      tokenAuth: {
        tokenId: "session-token",
        teamId: null,
        isOrganizationToken: false,
        userId: user.id,
      },
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        resourceIdentifier: "archestra-oidc",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer github-mock-access-token",
      expiresInSeconds: 300,
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "subject_token=keycloak-session-access-token",
    );
    expect(String(requestInit?.body)).toContain("audience=archestra-oidc");

    fetchMock.mockRestore();
  });

  test("rejects forbidden prototype segments in responseFieldPath", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser({ email: "prototype-segment@example.com" });
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "okta-prototype-segment",
      issuer: "https://example.okta.com",
      oidcConfig: {
        clientId: "web-client-id",
        tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
        enterpriseManagedCredentials: {
          providerType: "okta",
          clientId: "ai-agent-client-id",
          tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
          tokenEndpointAuthentication: "client_secret_post",
          clientSecret: "ai-agent-client-secret",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-prototype",
      providerId: identityProvider.providerId,
      userId: user.id,
      idToken: createJwt({ exp: futureExpSeconds(300) }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          issued_token_type: "urn:okta:params:oauth:token-type:secret",
          secret: { token: "ghu_managed_token" },
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      resolveEnterpriseTransportCredential({
        agentId: agent.id,
        tokenAuth: {
          tokenId: "session-token",
          teamId: null,
          isOrganizationToken: false,
          userId: user.id,
        },
        enterpriseManagedConfig: {
          requestedCredentialType: "secret",
          resourceIdentifier: "orn:okta:pam:github-secret",
          tokenInjectionMode: "authorization_bearer",
          responseFieldPath: "__proto__.token",
        },
      }),
    ).rejects.toThrow(
      "Enterprise-managed credential response field '__proto__.token' did not resolve to a value",
    );

    fetchMock.mockRestore();
  });
});

function createJwt(payload: Record<string, unknown>): string {
  return [
    base64UrlEncode({ alg: "none", typ: "JWT" }),
    base64UrlEncode(payload),
    "signature",
  ].join(".");
}

function base64UrlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64url")
    .replace(/=/g, "");
}

function futureExpSeconds(secondsFromNow: number): number {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}
