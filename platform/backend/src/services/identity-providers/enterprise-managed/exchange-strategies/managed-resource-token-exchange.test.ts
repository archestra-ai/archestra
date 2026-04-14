import { vi } from "vitest";
import type { ExternalIdentityProviderConfig } from "@/services/identity-providers/oidc";
import { describe, expect, test } from "@/test";
import { managedResourceTokenExchangeStrategy } from "./managed-resource-token-exchange";

describe("managedResourceTokenExchangeStrategy", () => {
  test("builds a managed-resource exchange request and normalizes a structured secret response", async () => {
    const identityProvider = makeIdentityProvider({
      issuer: "https://example.okta.com/oauth2/default",
      oidcConfig: {
        clientId: "web-client-id",
        tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
        enterpriseManagedCredentials: {
          clientId: "ai-agent-client-id",
          tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
          tokenEndpointAuthentication: "client_secret_post",
          clientSecret: "ai-agent-client-secret",
          subjectTokenType: "urn:ietf:params:oauth:token-type:id_token",
        },
      },
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

    const result =
      await managedResourceTokenExchangeStrategy.exchangeCredential({
        identityProvider,
        assertion: "user-id-token",
        enterpriseManagedConfig: {
          requestedCredentialType: "secret",
          resourceIdentifier: "orn:okta:pam:github-secret",
          audience: "github",
          scopes: ["repo", "read:org"],
          tokenInjectionMode: "authorization_bearer",
          responseFieldPath: "token",
        },
      });

    expect(result).toEqual({
      credentialType: "secret",
      expiresInSeconds: 300,
      value: { token: "ghu_managed_token" },
      issuedTokenType: "urn:okta:params:oauth:token-type:secret",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.okta.com/oauth2/v1/token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestInit?.body)).toContain(
      "requested_token_type=urn%3Aokta%3Aparams%3Aoauth%3Atoken-type%3Asecret",
    );
    expect(String(requestInit?.body)).toContain("subject_token=user-id-token");
    expect(String(requestInit?.body)).toContain(
      "resource=orn%3Aokta%3Apam%3Agithub-secret",
    );
    expect(String(requestInit?.body)).toContain("audience=github");
    expect(String(requestInit?.body)).toContain("scope=repo+read%3Aorg");
    expect(String(requestInit?.body)).toContain(
      "client_secret=ai-agent-client-secret",
    );

    fetchMock.mockRestore();
  });
});

function makeIdentityProvider(
  overrides: Partial<ExternalIdentityProviderConfig>,
): ExternalIdentityProviderConfig {
  return {
    id: "idp-1",
    providerId: "generic-oidc",
    issuer: "https://example.okta.com/oauth2/default",
    oidcConfig: null,
    ...overrides,
  };
}
