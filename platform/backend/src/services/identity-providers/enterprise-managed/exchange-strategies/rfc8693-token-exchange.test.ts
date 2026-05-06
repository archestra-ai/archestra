import { OAUTH_TOKEN_TYPE } from "@shared";
import { vi } from "vitest";
import type { ExternalIdentityProviderConfig } from "@/services/identity-providers/oidc";
import { describe, expect, test } from "@/test";
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
