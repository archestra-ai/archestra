// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { generateKeyPairSync } from "node:crypto";
import {
  OAUTH_CLIENT_ASSERTION_TYPE,
  OAUTH_TOKEN_TYPE,
} from "@archestra/shared";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ExternalIdentityProviderConfig } from "@/services/identity-providers/oidc";
import { spiffeIdForAgent, spiffeIssuer } from "../spiffe-issuer";
import { rfc8693TokenExchangeStrategy } from "./rfc8693-token-exchange";

describe("rfc8693TokenExchangeStrategy", () => {
  test("builds a standard token exchange request and returns a bearer token", async () => {
    const identityProvider = makeIdentityProvider({
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        enterpriseManagedCredentials: {
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          tokenEndpoint:
            "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "exchanged-access-token",
          issued_token_type: OAUTH_TOKEN_TYPE.AccessToken,
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await rfc8693TokenExchangeStrategy.exchangeCredential({
      identityProvider,
      assertion: "user-access-token",
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        resourceIdentifier: "archestra-oidc",
        scopes: ["openid", "profile"],
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      credentialType: "bearer_token",
      expiresInSeconds: 300,
      value: "exchanged-access-token",
      issuedTokenType: OAUTH_TOKEN_TYPE.AccessToken,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
    );
    expect(String(requestInit?.body)).toContain(
      "subject_token=user-access-token",
    );
    expect(String(requestInit?.body)).toContain(
      "subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token",
    );
    expect(String(requestInit?.body)).toContain("audience=archestra-oidc");
    expect(String(requestInit?.body)).toContain("scope=openid+profile");
    expect(String(requestInit?.body)).toContain(
      "client_secret=archestra-oidc-secret",
    );

    fetchMock.mockRestore();
  });

  test("includes requested_issuer for brokered external token exchange", async () => {
    const identityProvider = makeIdentityProvider({
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        enterpriseManagedCredentials: {
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          tokenEndpoint:
            "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "github-access-token",
          issued_token_type: OAUTH_TOKEN_TYPE.AccessToken,
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await rfc8693TokenExchangeStrategy.exchangeCredential({
      identityProvider,
      assertion: "user-access-token",
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        requestedIssuer: "github",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result.value).toBe("github-access-token");

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain("requested_issuer=github");

    fetchMock.mockRestore();
  });

  test("requests an ID-JAG with audience and resource for protected-resource token exchange", async () => {
    const identityProvider = makeIdentityProvider({
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "requesting-client",
        clientSecret: "requesting-secret",
        tokenEndpoint: "https://idp.example.com/token",
        enterpriseManagedCredentials: {
          clientId: "requesting-client",
          clientSecret: "requesting-secret",
          tokenEndpoint: "https://idp.example.com/token",
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: OAUTH_TOKEN_TYPE.IdToken,
        },
      },
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "id-jag-token",
          issued_token_type: OAUTH_TOKEN_TYPE.IdJag,
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await rfc8693TokenExchangeStrategy.exchangeCredential({
      identityProvider,
      assertion: "user-id-token",
      enterpriseManagedConfig: {
        requestedCredentialType: "id_jag",
        audience: "https://auth.resource.example.com",
        resourceIdentifier: "https://mcp.example.com/mcp",
        scopes: ["todos.read", "mcp.access"],
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      credentialType: "id_jag",
      expiresInSeconds: 300,
      value: "id-jag-token",
      issuedTokenType: OAUTH_TOKEN_TYPE.IdJag,
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid-jag",
    );
    expect(String(requestInit?.body)).toContain(
      "subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token",
    );
    expect(String(requestInit?.body)).toContain(
      "audience=https%3A%2F%2Fauth.resource.example.com",
    );
    expect(String(requestInit?.body)).toContain(
      "resource=https%3A%2F%2Fmcp.example.com%2Fmcp",
    );
    expect(String(requestInit?.body)).toContain("scope=todos.read+mcp.access");

    fetchMock.mockRestore();
  });
});

describe("rfc8693TokenExchangeStrategy with the agent as actor", () => {
  test("sends the agent's own client credentials token as the actor token", async () => {
    const fetchMock = mockKeycloak();
    const agentClientId = "agent-client-actor";

    const result = await rfc8693TokenExchangeStrategy.exchangeCredential({
      identityProvider: makeActorIdentityProvider({
        actorTokenScope: "agent-actor",
      }),
      assertion: "user-access-token",
      enterpriseManagedConfig: ACTOR_DOWNSTREAM_CONFIG,
      agentIdentity: {
        identityProviderId: "idp-1",
        externalId: agentClientId,
      },
    });

    expect(result).toMatchObject({
      value: "delegated-token",
      actor: { clientId: agentClientId },
    });
    const [actorRequest, exchange] = requestBodies(fetchMock);
    expect(actorRequest).toMatchObject({
      grant_type: "client_credentials",
      client_id: agentClientId,
      client_assertion_type: OAUTH_CLIENT_ASSERTION_TYPE.JwtBearer,
      scope: "agent-actor",
    });
    const { payload } = await jwtVerify(
      String(actorRequest?.client_assertion),
      ACTOR_KEY.publicKey,
    );
    expect(payload).toMatchObject({
      iss: agentClientId,
      sub: agentClientId,
      aud: KEYCLOAK_TOKEN_ENDPOINT,
    });
    expect(exchange).toMatchObject({
      client_id: "archestra-oidc",
      client_secret: "archestra-oidc-secret",
      subject_token: "user-access-token",
      actor_token: `actor-token-for-${agentClientId}`,
      actor_token_type: OAUTH_TOKEN_TYPE.AccessToken,
    });
    fetchMock.mockRestore();
  });

  test("reuses the agent's actor token for every person it acts for", async () => {
    const fetchMock = mockKeycloak();
    const agentClientId = "agent-client-reuse";

    for (const assertion of ["alice-token", "bob-token"]) {
      await rfc8693TokenExchangeStrategy.exchangeCredential({
        identityProvider: makeActorIdentityProvider(),
        assertion,
        enterpriseManagedConfig: ACTOR_DOWNSTREAM_CONFIG,
        agentIdentity: {
          identityProviderId: "idp-1",
          externalId: agentClientId,
        },
      });
    }

    expect(requestBodies(fetchMock).map((body) => body.grant_type)).toEqual([
      "client_credentials",
      "urn:ietf:params:oauth:grant-type:token-exchange",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ]);
    fetchMock.mockRestore();
  });

  test("reports the identity provider's refusal of the agent's own token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "unauthorized_client",
          error_description: "Client not enabled to retrieve service account",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      rfc8693TokenExchangeStrategy.exchangeCredential({
        identityProvider: makeActorIdentityProvider(),
        assertion: "user-access-token",
        enterpriseManagedConfig: ACTOR_DOWNSTREAM_CONFIG,
        agentIdentity: {
          identityProviderId: "idp-1",
          externalId: "agent-client-refused",
        },
      }),
    ).rejects.toThrow("Client not enabled to retrieve service account");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  test("fails closed before any request for an agent without an identity when one is required", async () => {
    const fetchMock = mockKeycloak();

    await expect(
      rfc8693TokenExchangeStrategy.exchangeCredential({
        identityProvider: makeActorIdentityProvider({
          requireAgentIdentity: true,
        }),
        assertion: "user-access-token",
        enterpriseManagedConfig: ACTOR_DOWNSTREAM_CONFIG,
        agentIdentity: null,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

describe("rfc8693TokenExchangeStrategy with SPIFFE agent identities", () => {
  beforeEach(() => {
    // Each test starts on an empty database, so no key the issuer cached.
    spiffeIssuer.clearCache();
  });

  test("sends the agent's JWT-SVID as the actor token, with no request of its own", async () => {
    const fetchMock = mockKeycloak();
    const spiffeId = spiffeIdForAgent("agent-spiffe");

    const result = await rfc8693TokenExchangeStrategy.exchangeCredential({
      identityProvider: makeActorIdentityProvider({ source: "spiffe" }),
      assertion: "user-access-token",
      enterpriseManagedConfig: ACTOR_DOWNSTREAM_CONFIG,
      agentIdentity: { identityProviderId: "idp-1", externalId: spiffeId },
    });

    expect(result).toMatchObject({ actor: { clientId: spiffeId } });
    const [exchange, ...others] = requestBodies(fetchMock);
    expect(others).toEqual([]);
    expect(exchange).toMatchObject({
      client_id: "archestra-oidc",
      subject_token: "user-access-token",
      actor_token_type: OAUTH_TOKEN_TYPE.Jwt,
    });
    const { payload } = await jwtVerify(
      String(exchange?.actor_token),
      createLocalJWKSet(await spiffeIssuer.jwks()),
      {
        issuer: spiffeIssuer.issuer,
        audience: "http://localhost:30081/realms/archestra",
      },
    );
    expect(payload.sub).toBe(spiffeId);
    fetchMock.mockRestore();
  });

  test("addresses the JWT-SVID to the configured audience", async () => {
    const fetchMock = mockKeycloak();

    await rfc8693TokenExchangeStrategy.exchangeCredential({
      identityProvider: makeActorIdentityProvider({
        source: "spiffe",
        spiffeAudience: "keycloak-spiffe",
      }),
      assertion: "user-access-token",
      enterpriseManagedConfig: ACTOR_DOWNSTREAM_CONFIG,
      agentIdentity: {
        identityProviderId: "idp-1",
        externalId: spiffeIdForAgent("agent-spiffe"),
      },
    });

    const [exchange] = requestBodies(fetchMock);
    expect(decodeJwt(String(exchange?.actor_token)).aud).toBe(
      "keycloak-spiffe",
    );
    fetchMock.mockRestore();
  });
});

const KEYCLOAK_TOKEN_ENDPOINT =
  "http://localhost:30081/realms/archestra/protocol/openid-connect/token";
const ACTOR_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACTOR_DOWNSTREAM_CONFIG = {
  requestedCredentialType: "bearer_token",
  resourceIdentifier: "downstream-api",
  tokenInjectionMode: "authorization_bearer",
} as const;

function makeActorIdentityProvider(
  agentIdentity: Record<string, unknown> = {},
): ExternalIdentityProviderConfig {
  return makeIdentityProvider({
    issuer: "http://localhost:30081/realms/archestra",
    oidcConfig: {
      clientId: "archestra-oidc",
      clientSecret: "archestra-oidc-secret",
      tokenEndpoint: KEYCLOAK_TOKEN_ENDPOINT,
      enterpriseManagedCredentials: {
        exchangeStrategy: "rfc8693",
        tokenEndpointAuthentication: "client_secret_post",
        subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        agentIdentity: {
          privateKeyPem: ACTOR_KEY.privateKey
            .export({ format: "pem", type: "pkcs8" })
            .toString(),
          privateKeyId: "actor-key",
          ...agentIdentity,
        },
      },
    },
  } as Partial<ExternalIdentityProviderConfig>);
}

/** A fake Keycloak token endpoint: actor tokens for client credentials, delegated tokens for exchanges. */
function mockKeycloak() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      const accessToken =
        body.grant_type === "client_credentials"
          ? `actor-token-for-${body.client_id}`
          : "delegated-token";
      return new Response(
        JSON.stringify({ access_token: accessToken, expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
}

function requestBodies(
  fetchMock: ReturnType<typeof mockKeycloak>,
): Array<Record<string, string>> {
  return fetchMock.mock.calls.map(([, init]) =>
    Object.fromEntries(new URLSearchParams(String(init?.body))),
  );
}

function makeIdentityProvider(
  overrides: Partial<ExternalIdentityProviderConfig>,
): ExternalIdentityProviderConfig {
  return {
    id: "idp-1",
    providerId: "keycloak",
    issuer: "http://localhost:30081/realms/archestra",
    oidcConfig: null,
    ...overrides,
  };
}
