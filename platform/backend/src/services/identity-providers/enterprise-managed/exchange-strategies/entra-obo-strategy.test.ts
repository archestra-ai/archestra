import { generateKeyPairSync } from "node:crypto";
import { OAUTH_CLIENT_ASSERTION_TYPE, OAUTH_TOKEN_TYPE } from "@shared";
import { vi } from "vitest";
import type { ExternalIdentityProviderConfig } from "@/services/identity-providers/oidc";
import { describe, expect, test } from "@/test";
import { entraOboStrategy } from "./entra-obo-strategy";

describe("entraOboStrategy", () => {
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
        scopes: ["https://graph.microsoft.com/.default"],
        tokenInjectionMode: "authorization_bearer",
      },
    });

    expect(result).toEqual({
      credentialType: "bearer_token",
      expiresInSeconds: 3599,
      value: "downstream-graph-access-token",
      issuedTokenType: OAUTH_TOKEN_TYPE.AccessToken,
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

  test("derives a .default scope from the configured resource identifier", async () => {
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
        resourceIdentifier: "api://downstream-app-id",
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
