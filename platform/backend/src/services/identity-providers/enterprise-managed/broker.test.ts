// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { OAUTH_TOKEN_TYPE } from "@archestra/shared";
import { jwtVerify } from "jose";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { agentOwner } from "@/types";
import {
  buildEnterpriseCredentialHeader,
  resolveEnterpriseTransportCredential,
} from "./broker";

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
          exchangeStrategy: "okta_managed",
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
      owner: agentOwner(agent.id),
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
          exchangeStrategy: "okta_managed",
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
          issued_token_type: OAUTH_TOKEN_TYPE.IdJag,
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
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

  test("passes through the resolved enterprise assertion without token exchange when configured for JWT passthrough", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "jwks-passthrough",
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "gateway-client",
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
      tokenAuth: {
        tokenId: "external-token",
        teamId: null,
        isOrganizationToken: false,
        userId: "user-1",
        isExternalIdp: true,
        rawToken: "external-idp-jwt",
      },
      enterpriseManagedConfig: {
        identityProviderId: identityProvider.id,
        assertionMode: "passthrough",
        requestedCredentialType: "bearer_token",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer external-idp-jwt",
      expiresInSeconds: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();

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
              issued_token_type: OAUTH_TOKEN_TYPE.AccessToken,
              expires_in: 300,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      });

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
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
        scopes: ["todos.read", "mcp.access"],
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer mcp-server-access-token",
      expiresInSeconds: 300,
      issuedTo: {
        clientId: "resource-client",
        clientType: "identity_provider",
      },
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
    expect(String(tokenRequest?.[1]?.body)).toContain(
      "scope=todos.read+mcp.access",
    );
    const tokenRequestHeaders = tokenRequest?.[1]?.headers as
      | Headers
      | undefined;
    expect(tokenRequestHeaders?.get("authorization")).toBe(
      `Basic ${Buffer.from("resource-client:resource-secret").toString("base64")}`,
    );

    fetchMock.mockRestore();
  });

  test("uses protected resource client credential overrides for ID-JAG exchange", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "id-jag-demo-idp",
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "idp-client",
        clientSecret: "idp-secret",
        tokenEndpoint: "https://idp.example.com/token",
        enterpriseManagedCredentials: {
          clientId: "idp-exchange-client",
          tokenEndpointAuthentication: "client_secret_basic",
          clientSecret: "idp-exchange-secret",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (
          url ===
          "https://resource.example.com/.well-known/oauth-protected-resource/mcp"
        ) {
          return Response.json({
            resource: "https://resource.example.com/mcp",
            authorization_servers: ["https://resource.example.com"],
          });
        }

        if (
          url ===
          "https://resource.example.com/.well-known/oauth-authorization-server"
        ) {
          return Response.json({
            token_endpoint: "https://resource.example.com/token",
          });
        }

        if (url === "https://resource.example.com/token") {
          const headers = init?.headers as Headers;
          expect(headers.get("authorization")).toBe(
            `Basic ${Buffer.from("resource-client:resource-secret").toString("base64")}`,
          );
          return Response.json({
            access_token: "resource-access-token",
            expires_in: 300,
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      });

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
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
        clientIdOverride: "resource-client",
        clientSecretOverride: "resource-secret",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toMatchObject({
      headerName: "Authorization",
      headerValue: "Bearer resource-access-token",
    });

    fetchMock.mockRestore();
  });

  test("mints an ID-JAG from the session IdP token before exchanging at an OAuth protected resource", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser({ email: "id-jag-session@example.com" });
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "generic-id-jag",
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "gateway-client",
        tokenEndpoint: "https://idp.example.com/token",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          clientId: "resource-client",
          tokenEndpoint: "https://idp.example.com/token",
          tokenEndpointAuthentication: "client_secret_basic",
          clientSecret: "resource-secret",
          subjectTokenType: OAUTH_TOKEN_TYPE.IdToken,
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-generic-id-jag",
      providerId: identityProvider.providerId,
      userId: user.id,
      idToken: createJwt({ exp: futureExpSeconds(300) }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "https://idp.example.com/token") {
          expect(String(init?.body)).toContain(
            "requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid-jag",
          );
          return new Response(
            JSON.stringify({
              access_token: "session-id-jag",
              issued_token_type: OAUTH_TOKEN_TYPE.IdJag,
              expires_in: 300,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

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
          expect(String(init?.body)).toContain("assertion=session-id-jag");
          return new Response(
            JSON.stringify({
              access_token: "mcp-server-access-token",
              issued_token_type: OAUTH_TOKEN_TYPE.AccessToken,
              expires_in: 300,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      });

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
      tokenAuth: {
        tokenId: "session-token",
        teamId: null,
        isOrganizationToken: false,
        userId: user.id,
        isSessionAuth: true,
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
      issuedTo: {
        clientId: "resource-client",
        clientType: "identity_provider",
      },
    });

    fetchMock.mockRestore();
  });

  test("runs both ID-JAG steps as the calling Okta AI agent", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser({ email: "okta-agent@example.com" });
    const agentKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "okta-ai-agents",
      issuer: "https://example.okta.com",
      oidcConfig: {
        clientId: "archestra-sso",
        clientSecret: "archestra-sso-secret",
        tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
        enterpriseManagedCredentials: {
          exchangeStrategy: "okta_managed",
          tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: OAUTH_TOKEN_TYPE.IdToken,
          agentIdentity: {
            privateKeyPem: agentKey.privateKey
              .export({ format: "pem", type: "pkcs8" })
              .toString(),
            privateKeyId: "archestra-agents",
          },
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });
    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-okta-ai-agent",
      providerId: identityProvider.providerId,
      userId: user.id,
      idToken: createJwt({ exp: futureExpSeconds(300) }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const tokenRequests: Array<{ url: string; body: Record<string, string> }> =
      [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes("/.well-known/oauth-protected-resource")) {
          return Response.json({
            resource: "https://mcp.example.com/mcp",
            authorization_servers: ["https://example.okta.com/oauth2/aus-mcp"],
          });
        }
        if (url.includes("/.well-known/oauth-authorization-server")) {
          return Response.json({
            token_endpoint: "https://example.okta.com/oauth2/aus-mcp/v1/token",
          });
        }
        tokenRequests.push({
          url,
          body: Object.fromEntries(new URLSearchParams(String(init?.body))),
        });
        return Response.json({
          access_token:
            url === "https://example.okta.com/oauth2/v1/token"
              ? "agent-id-jag"
              : "agent-access-token",
          expires_in: 300,
        });
      });

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
      tokenAuth: {
        tokenId: "session-token",
        teamId: null,
        isOrganizationToken: false,
        userId: user.id,
        isSessionAuth: true,
      },
      enterpriseManagedConfig: {
        requestedCredentialType: "id_jag",
        resourceType: "oauth_protected_resource",
        resourceIdentifier: "https://mcp.example.com/mcp",
        audience: "https://example.okta.com/oauth2/aus-mcp",
        tokenInjectionMode: "authorization_bearer",
      },
      agentIdentity: {
        identityProviderId: identityProvider.id,
        externalId: "wlp-agent-1",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer agent-access-token",
      expiresInSeconds: 300,
      issuedTo: { clientId: "wlp-agent-1", clientType: "okta_ai_agent" },
    });
    const [idJagRequest, accessTokenRequest] = tokenRequests;
    expect(idJagRequest?.body).toMatchObject({
      client_id: "wlp-agent-1",
      requested_token_type: OAUTH_TOKEN_TYPE.IdJag,
      resource: "https://mcp.example.com/mcp",
    });
    expect(accessTokenRequest).toMatchObject({
      url: "https://example.okta.com/oauth2/aus-mcp/v1/token",
      body: { client_id: "wlp-agent-1", assertion: "agent-id-jag" },
    });
    const { payload } = await jwtVerify(
      String(accessTokenRequest?.body.client_assertion),
      agentKey.publicKey,
    );
    expect(payload).toMatchObject({
      iss: "wlp-agent-1",
      aud: "https://example.okta.com/oauth2/aus-mcp/v1/token",
    });
    fetchMock.mockRestore();
  });

  test("refuses an agent binding that belongs to another identity provider", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser({ email: "wrong-idp-binding@example.com" });
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "keycloak-binding-check",
      issuer: "https://keycloak.example.com/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint: "https://keycloak.example.com/token",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          tokenEndpoint: "https://keycloak.example.com/token",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });
    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-wrong-idp-binding",
      providerId: identityProvider.providerId,
      userId: user.id,
      accessToken: "keycloak-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 300_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      resolveEnterpriseTransportCredential({
        owner: agentOwner(agent.id),
        tokenAuth: {
          tokenId: "session-token",
          teamId: null,
          isOrganizationToken: false,
          userId: user.id,
          isSessionAuth: true,
        },
        enterpriseManagedConfig: {
          requestedCredentialType: "bearer_token",
          resourceIdentifier: "downstream-api",
          tokenInjectionMode: "authorization_bearer",
        },
        agentIdentity: {
          identityProviderId: "some-other-identity-provider",
          externalId: "agent-client",
        },
      }),
    ).rejects.toThrow("different identity provider");
    expect(fetchMock).not.toHaveBeenCalled();
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
          exchangeStrategy: "rfc8693",
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          tokenEndpoint:
            "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
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
          issued_token_type: OAUTH_TOKEN_TYPE.AccessToken,
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
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

  test("defaults generic enterprise-managed OIDC providers to RFC 8693 token exchange", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser({ email: "generic-broker@example.com" });
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "generic-broker",
      issuer: "https://idp.example.com/oauth2/default",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint: "https://idp.example.com/oauth2/v1/token",
        enterpriseManagedCredentials: {
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          tokenEndpoint: "https://idp.example.com/oauth2/v1/token",
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-generic",
      providerId: identityProvider.providerId,
      userId: user.id,
      accessToken: "generic-session-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 300_000),
      idToken: "generic-session-id-token",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "generic-downstream-access-token",
          issued_token_type: OAUTH_TOKEN_TYPE.AccessToken,
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
      tokenAuth: {
        tokenId: "session-token",
        teamId: null,
        isOrganizationToken: false,
        userId: user.id,
      },
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        resourceIdentifier: "api://downstream-app-id",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer generic-downstream-access-token",
      expiresInSeconds: 300,
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "subject_token=generic-session-access-token",
    );
    expect(String(requestInit?.body)).toContain(
      "audience=api%3A%2F%2Fdownstream-app-id",
    );

    fetchMock.mockRestore();
  });

  test("exchanges an Entra session access token using OBO for a downstream bearer token", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser({ email: "entra-obo@example.com" });
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "EntraID",
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token",
        enterpriseManagedCredentials: {
          exchangeStrategy: "entra_obo",
          clientId: "middle-tier-client-id",
          clientSecret: "middle-tier-client-secret",
          tokenEndpoint:
            "https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token",
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-entra",
      providerId: identityProvider.providerId,
      userId: user.id,
      accessToken: "entra-session-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 300_000),
      idToken: "entra-session-id-token",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "downstream-graph-access-token",
          expires_in: 3599,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
      tokenAuth: {
        tokenId: "session-token",
        teamId: null,
        isOrganizationToken: false,
        userId: user.id,
      },
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        resourceIdentifier: "https://graph.microsoft.com",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer downstream-graph-access-token",
      expiresInSeconds: 3599,
      issuedTo: {
        clientId: "middle-tier-client-id",
        clientType: "identity_provider",
      },
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "requested_token_use=on_behalf_of",
    );
    expect(String(requestInit?.body)).toContain(
      "assertion=entra-session-access-token",
    );
    expect(String(requestInit?.body)).toContain(
      "scope=https%3A%2F%2Fgraph.microsoft.com%2F.default",
    );

    fetchMock.mockRestore();
  });

  test("respects an explicit RFC 8693 strategy on an Entra issuer", async ({
    makeAgent,
    makeIdentityProvider,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser({ email: "entra-rfc8693@example.com" });
    const identityProvider = await makeIdentityProvider(organization.id, {
      providerId: "EntraID",
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          tokenEndpoint:
            "https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token",
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-entra-rfc8693",
      providerId: identityProvider.providerId,
      userId: user.id,
      accessToken: "entra-session-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 300_000),
      idToken: "entra-session-id-token",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "downstream-access-token",
          issued_token_type: OAUTH_TOKEN_TYPE.AccessToken,
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await resolveEnterpriseTransportCredential({
      owner: agentOwner(agent.id),
      tokenAuth: {
        tokenId: "session-token",
        teamId: null,
        isOrganizationToken: false,
        userId: user.id,
      },
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        resourceIdentifier: "api://downstream-app-id",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer downstream-access-token",
      expiresInSeconds: 300,
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "subject_token=entra-session-access-token",
    );
    expect(String(requestInit?.body)).toContain(
      "audience=api%3A%2F%2Fdownstream-app-id",
    );
    expect(String(requestInit?.body)).not.toContain(
      "requested_token_use=on_behalf_of",
    );
    expect(String(requestInit?.body)).not.toContain(
      "assertion=entra-session-access-token",
    );

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
          exchangeStrategy: "okta_managed",
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
        owner: agentOwner(agent.id),
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

describe("buildEnterpriseCredentialHeader", () => {
  test("sends the credential under the configured custom header, unprefixed", () => {
    expect(
      buildEnterpriseCredentialHeader({
        config: {
          tokenInjectionMode: "header",
          headerName: "X-Provider-Token",
        },
        value: "downstream-token",
      }),
    ).toEqual({
      headerName: "X-Provider-Token",
      headerValue: "downstream-token",
    });
  });

  test("does not fall back to Authorization when a custom header is configured", () => {
    const { headerName } = buildEnterpriseCredentialHeader({
      config: { tokenInjectionMode: "header", headerName: "X-Provider-Token" },
      value: "downstream-token",
    });

    expect(headerName.toLowerCase()).not.toBe("authorization");
  });

  test("rejects custom-header mode that is missing a header name", () => {
    expect(() =>
      buildEnterpriseCredentialHeader({
        config: { tokenInjectionMode: "header" },
        value: "downstream-token",
      }),
    ).toThrow(
      "Enterprise-managed credential injection mode 'header' requires headerName",
    );
  });

  test.each([
    "env",
    "body_field",
  ] as const)("refuses to smuggle a %s-mode credential into an Authorization header", (tokenInjectionMode) => {
    expect(() =>
      buildEnterpriseCredentialHeader({
        config: { tokenInjectionMode },
        value: "downstream-token",
      }),
    ).toThrow(/is not supported for HTTP MCP transports/);
  });

  test("sends the raw value for raw_authorization mode", () => {
    expect(
      buildEnterpriseCredentialHeader({
        config: { tokenInjectionMode: "raw_authorization" },
        value: "token abc123",
      }),
    ).toEqual({ headerName: "Authorization", headerValue: "token abc123" });
  });

  test("defaults to a bearer Authorization header", () => {
    expect(
      buildEnterpriseCredentialHeader({
        config: {},
        value: "downstream-token",
      }),
    ).toEqual({
      headerName: "Authorization",
      headerValue: "Bearer downstream-token",
    });
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
