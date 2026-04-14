import { vi } from "vitest";
import type { ExternalIdentityProviderConfig } from "@/services/identity-providers/oidc";
import { describe, expect, test } from "@/test";
import { standardTokenExchangeStrategy } from "./standard-token-exchange";

describe("standardTokenExchangeStrategy", () => {
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
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "exchanged-access-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await standardTokenExchangeStrategy.exchangeCredential({
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
      issuedTokenType: "urn:ietf:params:oauth:token-type:access_token",
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
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "github-access-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await standardTokenExchangeStrategy.exchangeCredential({
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
