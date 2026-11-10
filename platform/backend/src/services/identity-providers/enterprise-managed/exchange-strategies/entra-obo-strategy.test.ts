// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { generateKeyPairSync } from "node:crypto";
import {
  OAUTH_CLIENT_ASSERTION_TYPE,
  OAUTH_TOKEN_TYPE,
} from "@archestra/shared";
import { describe, expect, test, vi } from "vitest";
import type { ExternalIdentityProviderConfig } from "@/services/identity-providers/oidc";
import { entraOboStrategy } from "./entra-obo-strategy";

describe("entraOboStrategy", () => {
  test.each([
    {},
    { scopes: [] },
    { scopes: [""] },
    { scopes: [" \t "] },
    { resourceIdentifier: " \t ", audience: " " },
  ])("rejects a missing target before issuer discovery: %j", async (target) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Synthetic issuer unavailable"));

    await expect(
      entraOboStrategy.exchangeCredential({
        identityProvider: makeIdentityProvider({
          issuer: "https://identity.example.com",
          oidcConfig: {
            clientId: "synthetic-client",
            clientSecret: "synthetic-secret",
            enterpriseManagedCredentials: {
              exchangeStrategy: "entra_obo",
              subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
            },
          },
        }),
        assertion: "synthetic-session-token",
        enterpriseManagedConfig: {
          requestedCredentialType: "bearer_token",
          tokenInjectionMode: "authorization_bearer",
          ...target,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("builds an Entra OBO request and returns a bearer token", async () => {
    const identityProvider = makeIdentityProvider({
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      oidcConfig: {
        clientId: "web-client-id",
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

    const result = await entraOboStrategy.exchangeCredential({
      identityProvider,
      assertion: "user-access-token",
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        scopes: [" ", " https://graph.microsoft.com/.default ", ""],
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      credentialType: "bearer_token",
      expiresInSeconds: 3599,
      value: "downstream-graph-access-token",
      issuedTokenType: OAUTH_TOKEN_TYPE.AccessToken,
      issuedTo: {
        clientId: "middle-tier-client-id",
        clientType: "identity_provider",
      },
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
    );
    expect(String(requestInit?.body)).toContain(
      "requested_token_use=on_behalf_of",
    );
    expect(String(requestInit?.body)).toContain("assertion=user-access-token");
    expect(String(requestInit?.body)).toContain(
      "scope=https%3A%2F%2Fgraph.microsoft.com%2F.default",
    );
    expect(String(requestInit?.body)).toContain(
      "client_secret=middle-tier-client-secret",
    );

    fetchMock.mockRestore();
  });

  test("maps AADSTS50013 to actionable guidance about Graph-audience assertions", async () => {
    const identityProvider = makeIdentityProvider({
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      oidcConfig: {
        clientId: "web-client-id",
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

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description:
            "AADSTS50013: Assertion failed signature validation. [Reason - Key was found, but use of the key to verify the signature failed.]",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      entraOboStrategy.exchangeCredential({
        identityProvider,
        assertion: "graph-audience-access-token",
        enterpriseManagedConfig: {
          requestedCredentialType: "bearer_token",
          scopes: ["api://downstream-app/.default"],
          tokenInjectionMode: "authorization_bearer",
        },
      }),
    ).rejects.toThrow(/issued for Microsoft Graph.*AADSTS50013/s);

    fetchMock.mockRestore();
  });

  test.each([
    400, 401,
  ])("reports provider credential rejection (%i) as a configuration error", async (status) => {
    const identityProvider = makeIdentityProvider({
      oidcConfig: {
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
        tokenEndpoint: "https://identity.example.com/token",
        enterpriseManagedCredentials: { exchangeStrategy: "entra_obo" },
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "The supplied assertion has the wrong audience",
        }),
        { status, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(
      entraOboStrategy.exchangeCredential({
        identityProvider,
        assertion: "synthetic-wrong-audience-token",
        enterpriseManagedConfig: {
          requestedCredentialType: "bearer_token",
          scopes: ["api://synthetic-resource/.default"],
          tokenInjectionMode: "authorization_bearer",
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "The supplied assertion has the wrong audience",
    });
  });

  test.each([
    429, 500, 503,
  ])("keeps provider availability failures (%i) as server errors", async (status) => {
    const identityProvider = makeIdentityProvider({
      oidcConfig: {
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
        tokenEndpoint: "https://identity.example.com/token",
        enterpriseManagedCredentials: { exchangeStrategy: "entra_obo" },
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await entraOboStrategy
      .exchangeCredential({
        identityProvider,
        assertion: "synthetic-session-token",
        enterpriseManagedConfig: {
          requestedCredentialType: "bearer_token",
          scopes: ["api://synthetic-resource/.default"],
          tokenInjectionMode: "authorization_bearer",
        },
      })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toHaveProperty("statusCode");
  });

  test.each([
    { resourceIdentifier: "api://downstream-app-id" },
    { audience: "api://downstream-app-id" },
    { resourceIdentifier: " ", audience: " api://downstream-app-id/ " },
    { scopes: [" \t "], resourceIdentifier: "api://downstream-app-id" },
  ])("derives a .default scope from the configured target: %j", async (target) => {
    const identityProvider = makeIdentityProvider({
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      oidcConfig: {
        clientId: "web-client-id",
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

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "resource-access-token",
          expires_in: 300,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await entraOboStrategy.exchangeCredential({
      identityProvider,
      assertion: "user-access-token",
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        ...target,
        tokenInjectionMode: "authorization_bearer",
      },
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "scope=api%3A%2F%2Fdownstream-app-id%2F.default",
    );

    fetchMock.mockRestore();
  });

  test("builds an ES256 client assertion for private_key_jwt with EC keys", async () => {
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const identityProvider = makeIdentityProvider({
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      oidcConfig: {
        clientId: "web-client-id",
        tokenEndpoint:
          "https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token",
        enterpriseManagedCredentials: {
          exchangeStrategy: "entra_obo",
          clientId: "middle-tier-client-id",
          privateKeyId: "test-key-id",
          privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
          tokenEndpoint:
            "https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token",
          tokenEndpointAuthentication: "private_key_jwt",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
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

    await entraOboStrategy.exchangeCredential({
      identityProvider,
      assertion: "user-access-token",
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        scopes: ["https://graph.microsoft.com/.default"],
        tokenInjectionMode: "authorization_bearer",
      },
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    const requestBody = new URLSearchParams(String(requestInit?.body));
    expect(requestBody.get("client_secret")).toBeNull();
    expect(requestBody.get("client_assertion_type")).toBe(
      OAUTH_CLIENT_ASSERTION_TYPE.JwtBearer,
    );

    const clientAssertion = requestBody.get("client_assertion");
    expect(clientAssertion).toBeTruthy();
    if (!clientAssertion) {
      throw new Error("Expected a client assertion to be present");
    }

    const [encodedHeader] = clientAssertion.split(".");
    if (!encodedHeader) {
      throw new Error("Expected the client assertion to include a JWT header");
    }

    expect(
      JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")),
    ).toMatchObject({
      alg: "ES256",
      kid: "test-key-id",
    });

    fetchMock.mockRestore();
  });
});

describe("entraOboStrategy with Entra Agent ID", () => {
  test("exchanges as the agent identity: hop to the blueprint, exchange token with fmi_path, then OBO", async () => {
    const fetchMock = mockTokenEndpoint();

    const result = await entraOboStrategy.exchangeCredential({
      identityProvider: makeAgentIdIdentityProvider(),
      assertion: makeJwt({ aud: SSO_CLIENT_ID, oid: "user-1" }),
      enterpriseManagedConfig: DOWNSTREAM_CONFIG,
      entraAgentIdentityId: AGENT_IDENTITY_ID,
    });

    expect(result).toMatchObject({
      credentialType: "bearer_token",
      value: `downstream-token-for-${AGENT_IDENTITY_ID}`,
      issuedTo: {
        clientId: AGENT_IDENTITY_ID,
        clientType: "entra_agent_identity",
      },
    });
    const [hop, exchangeToken, onBehalfOf] = requestBodies(fetchMock);
    expect(hop).toMatchObject({
      client_id: SSO_CLIENT_ID,
      client_secret: "sso-secret",
      requested_token_use: "on_behalf_of",
      scope: `api://${BLUEPRINT_CLIENT_ID}/.default`,
    });
    expect(exchangeToken).toMatchObject({
      client_id: BLUEPRINT_CLIENT_ID,
      client_secret: "blueprint-secret",
      grant_type: "client_credentials",
      scope: "api://AzureADTokenExchange/.default",
      fmi_path: AGENT_IDENTITY_ID,
    });
    expect(onBehalfOf).toMatchObject({
      client_id: AGENT_IDENTITY_ID,
      client_assertion_type: OAUTH_CLIENT_ASSERTION_TYPE.JwtBearer,
      client_assertion: `exchange-token-for-${AGENT_IDENTITY_ID}`,
      assertion: "blueprint-audience-user-token",
      requested_token_use: "on_behalf_of",
      scope: "api://downstream-api/.default",
    });
    expect(onBehalfOf).not.toHaveProperty("client_secret");
    fetchMock.mockRestore();
  });

  test("skips the hop when the user's token already has the blueprint as audience, and reuses the agent's exchange token across users", async () => {
    const fetchMock = mockTokenEndpoint();
    const agentIdentityId = "11111111-2222-3333-4444-555555555555";

    for (const oid of ["user-1", "user-2"]) {
      await entraOboStrategy.exchangeCredential({
        identityProvider: makeAgentIdIdentityProvider(),
        assertion: makeJwt({ aud: BLUEPRINT_CLIENT_ID, oid }),
        enterpriseManagedConfig: DOWNSTREAM_CONFIG,
        entraAgentIdentityId: agentIdentityId,
      });
    }

    const bodies = requestBodies(fetchMock);
    expect(bodies.map((body) => body.client_id)).toEqual([
      BLUEPRINT_CLIENT_ID,
      agentIdentityId,
      agentIdentityId,
    ]);
    fetchMock.mockRestore();
  });

  test("signs the blueprint's client assertion with the certificate thumbprint as x5t", async () => {
    const fetchMock = mockTokenEndpoint();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const thumbprint = "0123456789abcdef0123456789abcdef01234567";

    await entraOboStrategy.exchangeCredential({
      identityProvider: makeAgentIdIdentityProvider({
        clientSecret: undefined,
        privateKeyPem: privateKey
          .export({ format: "pem", type: "pkcs8" })
          .toString(),
        certificateThumbprint: thumbprint,
      }),
      assertion: makeJwt({ aud: BLUEPRINT_CLIENT_ID }),
      enterpriseManagedConfig: DOWNSTREAM_CONFIG,
      entraAgentIdentityId: "99999999-2222-3333-4444-555555555555",
    });

    const [exchangeToken] = requestBodies(fetchMock);
    expect(exchangeToken).not.toHaveProperty("client_secret");
    const header = JSON.parse(
      Buffer.from(
        String(exchangeToken?.client_assertion).split(".")[0] ?? "",
        "base64url",
      ).toString("utf8"),
    );
    expect(header).toMatchObject({
      alg: "RS256",
      x5t: Buffer.from(thumbprint, "hex").toString("base64url"),
    });
    fetchMock.mockRestore();
  });

  test("fails closed for an agent without an identity when the blueprint requires one", async () => {
    const fetchMock = mockTokenEndpoint();

    await expect(
      entraOboStrategy.exchangeCredential({
        identityProvider: makeAgentIdIdentityProvider({
          requireAgentIdentity: true,
        }),
        assertion: makeJwt({ aud: SSO_CLIENT_ID }),
        enterpriseManagedConfig: DOWNSTREAM_CONFIG,
        entraAgentIdentityId: null,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  test("install-time discovery, with no calling agent, still uses the identity provider's client", async () => {
    const fetchMock = mockTokenEndpoint();

    const result = await entraOboStrategy.exchangeCredential({
      identityProvider: makeAgentIdIdentityProvider({
        requireAgentIdentity: true,
      }),
      assertion: makeJwt({ aud: SSO_CLIENT_ID }),
      enterpriseManagedConfig: DOWNSTREAM_CONFIG,
    });

    expect(result.issuedTo).toEqual({
      clientId: SSO_CLIENT_ID,
      clientType: "identity_provider",
    });
    fetchMock.mockRestore();
  });

  test("refuses an agent bound to an identity when the identity provider has no blueprint", async () => {
    const fetchMock = mockTokenEndpoint();

    await expect(
      entraOboStrategy.exchangeCredential({
        identityProvider: makeAgentIdIdentityProvider(null),
        assertion: makeJwt({ aud: SSO_CLIENT_ID }),
        enterpriseManagedConfig: DOWNSTREAM_CONFIG,
        entraAgentIdentityId: AGENT_IDENTITY_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

describe("entraOboStrategy with an MCP server override client", () => {
  test("addresses the user's token to the override client, then exchanges with the override's own secret", async () => {
    const fetchMock = mockTokenEndpoint();

    const result = await entraOboStrategy.exchangeCredential({
      identityProvider: makeAgentIdIdentityProvider(null),
      assertion: makeJwt({ aud: SSO_CLIENT_ID }),
      enterpriseManagedConfig: {
        ...DOWNSTREAM_CONFIG,
        clientIdOverride: OVERRIDE_CLIENT_ID,
        clientSecretOverride: "override-secret",
      },
      entraAgentIdentityId: null,
    });

    expect(result.issuedTo).toEqual({
      clientId: OVERRIDE_CLIENT_ID,
      clientType: "mcp_server",
    });
    const [hop, onBehalfOf] = requestBodies(fetchMock);
    expect(hop).toMatchObject({
      client_id: SSO_CLIENT_ID,
      scope: `api://${OVERRIDE_CLIENT_ID}/.default`,
    });
    expect(onBehalfOf).toMatchObject({
      client_id: OVERRIDE_CLIENT_ID,
      client_secret: "override-secret",
      assertion: "override-audience-user-token",
      scope: "api://downstream-api/.default",
    });
    fetchMock.mockRestore();
  });

  test("an agent identity takes precedence over the server's override client", async () => {
    const fetchMock = mockTokenEndpoint();

    const result = await entraOboStrategy.exchangeCredential({
      identityProvider: makeAgentIdIdentityProvider(),
      assertion: makeJwt({ aud: BLUEPRINT_CLIENT_ID }),
      enterpriseManagedConfig: {
        ...DOWNSTREAM_CONFIG,
        clientIdOverride: OVERRIDE_CLIENT_ID,
        clientSecretOverride: "override-secret",
      },
      entraAgentIdentityId: "77777777-2222-3333-4444-555555555555",
    });

    expect(result.issuedTo?.clientType).toBe("entra_agent_identity");
    fetchMock.mockRestore();
  });

  test("refuses an override client that has no credential", async () => {
    const fetchMock = mockTokenEndpoint();

    await expect(
      entraOboStrategy.exchangeCredential({
        identityProvider: makeAgentIdIdentityProvider(null),
        assertion: makeJwt({ aud: SSO_CLIENT_ID }),
        enterpriseManagedConfig: {
          ...DOWNSTREAM_CONFIG,
          clientIdOverride: OVERRIDE_CLIENT_ID,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

const SSO_CLIENT_ID = "sso-client-id";
const BLUEPRINT_CLIENT_ID = "blueprint-client-id";
const OVERRIDE_CLIENT_ID = "override-client-id";
const AGENT_IDENTITY_ID = "aaaaaaaa-2222-3333-4444-555555555555";
const TOKEN_ENDPOINT =
  "https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token";
const DOWNSTREAM_CONFIG = {
  requestedCredentialType: "bearer_token",
  tokenInjectionMode: "authorization_bearer",
  resourceIdentifier: "api://downstream-api",
} as const;

function makeAgentIdIdentityProvider(
  entraAgentId: Record<string, unknown> | null = {},
): ExternalIdentityProviderConfig {
  return makeIdentityProvider({
    oidcConfig: {
      clientId: SSO_CLIENT_ID,
      clientSecret: "sso-secret",
      tokenEndpoint: TOKEN_ENDPOINT,
      enterpriseManagedCredentials: {
        exchangeStrategy: "entra_obo",
        subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        ...(entraAgentId
          ? {
              entraAgentId: {
                blueprintClientId: BLUEPRINT_CLIENT_ID,
                clientSecret: "blueprint-secret",
                ...entraAgentId,
              },
            }
          : {}),
      },
    },
  } as Partial<ExternalIdentityProviderConfig>);
}

/** A fake Entra token endpoint that answers each grant with a recognizable token. */
function mockTokenEndpoint() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      let accessToken: string;
      if (body.grant_type === "client_credentials") {
        accessToken = `exchange-token-for-${body.fmi_path}`;
      } else if (body.client_id === SSO_CLIENT_ID) {
        accessToken =
          body.scope === `api://${BLUEPRINT_CLIENT_ID}/.default`
            ? "blueprint-audience-user-token"
            : body.scope === `api://${OVERRIDE_CLIENT_ID}/.default`
              ? "override-audience-user-token"
              : `downstream-token-for-${body.client_id}`;
      } else {
        accessToken = `downstream-token-for-${body.client_id}`;
      }
      return new Response(
        JSON.stringify({ access_token: accessToken, expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
}

function requestBodies(
  fetchMock: ReturnType<typeof mockTokenEndpoint>,
): Array<Record<string, string>> {
  return fetchMock.mock.calls.map(([, init]) =>
    Object.fromEntries(new URLSearchParams(String(init?.body))),
  );
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

function makeIdentityProvider(
  overrides: Partial<ExternalIdentityProviderConfig>,
): ExternalIdentityProviderConfig {
  return {
    id: "idp-1",
    providerId: "EntraID",
    issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
    oidcConfig: null,
    ...overrides,
  };
}
