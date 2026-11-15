// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { generateKeyPairSync } from "node:crypto";
import {
  OAUTH_CLIENT_ASSERTION_TYPE,
  OAUTH_TOKEN_TYPE,
} from "@archestra/shared";
import { jwtVerify } from "jose";
import { describe, expect, test, vi } from "vitest";
import type { ExternalIdentityProviderConfig } from "@/services/identity-providers/oidc";
import { oktaManagedCredentialExchangeStrategy } from "./okta-managed-credential-exchange";

describe("oktaManagedCredentialExchangeStrategy", () => {
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
          subjectTokenType: OAUTH_TOKEN_TYPE.IdToken,
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
      await oktaManagedCredentialExchangeStrategy.exchangeCredential({
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

describe("oktaManagedCredentialExchangeStrategy with Okta AI agents", () => {
  test("requests the ID-JAG as the agent's own client, signed with the identity provider's agent key", async () => {
    const fetchMock = mockIdJagResponse();

    const result =
      await oktaManagedCredentialExchangeStrategy.exchangeCredential({
        identityProvider: makeAgentIdentityProvider(),
        assertion: "user-id-token",
        enterpriseManagedConfig: ID_JAG_CONFIG,
        agentIdentity: { identityProviderId: "idp-1", externalId: AGENT_ID },
      });

    expect(result).toMatchObject({
      value: "id-jag",
      issuedTo: { clientId: AGENT_ID, clientType: "okta_ai_agent" },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(ORG_TOKEN_ENDPOINT);
    const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
    expect(body).toMatchObject({
      client_id: AGENT_ID,
      client_assertion_type: OAUTH_CLIENT_ASSERTION_TYPE.JwtBearer,
      requested_token_type: OAUTH_TOKEN_TYPE.IdJag,
      subject_token: "user-id-token",
      subject_token_type: OAUTH_TOKEN_TYPE.IdToken,
      resource: "https://mcp.example.com",
    });
    expect(body).not.toHaveProperty("client_secret");
    const { payload, protectedHeader } = await jwtVerify(
      String(body.client_assertion),
      AGENT_KEY.publicKey,
    );
    expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "agent-key" });
    expect(payload).toMatchObject({
      iss: AGENT_ID,
      sub: AGENT_ID,
      aud: ORG_TOKEN_ENDPOINT,
    });
    fetchMock.mockRestore();
  });

  test("fails closed before any request for an agent without an identity when one is required", async () => {
    const fetchMock = mockIdJagResponse();

    await expect(
      oktaManagedCredentialExchangeStrategy.exchangeCredential({
        identityProvider: makeAgentIdentityProvider({
          requireAgentIdentity: true,
        }),
        assertion: "user-id-token",
        enterpriseManagedConfig: ID_JAG_CONFIG,
        agentIdentity: null,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  test("refuses a bound agent when the identity provider has no agent key", async () => {
    const fetchMock = mockIdJagResponse();

    await expect(
      oktaManagedCredentialExchangeStrategy.exchangeCredential({
        identityProvider: makeAgentIdentityProvider({
          privateKeyPem: undefined,
        }),
        assertion: "user-id-token",
        enterpriseManagedConfig: ID_JAG_CONFIG,
        agentIdentity: { identityProviderId: "idp-1", externalId: AGENT_ID },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

const AGENT_ID = "wlp-agent-1";
const ORG_TOKEN_ENDPOINT = "https://example.okta.com/oauth2/v1/token";
const AGENT_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ID_JAG_CONFIG = {
  requestedCredentialType: "id_jag",
  resourceType: "oauth_protected_resource",
  resourceIdentifier: "https://mcp.example.com",
  audience: "https://example.okta.com/oauth2/aus-resource",
  tokenInjectionMode: "authorization_bearer",
} as const;

function makeAgentIdentityProvider(
  agentIdentity: Record<string, unknown> = {},
): ExternalIdentityProviderConfig {
  return makeIdentityProvider({
    oidcConfig: {
      clientId: "sso-client-id",
      clientSecret: "sso-secret",
      tokenEndpoint: ORG_TOKEN_ENDPOINT,
      enterpriseManagedCredentials: {
        exchangeStrategy: "okta_managed",
        tokenEndpointAuthentication: "client_secret_post",
        agentIdentity: {
          privateKeyPem: AGENT_KEY.privateKey
            .export({ format: "pem", type: "pkcs8" })
            .toString(),
          privateKeyId: "agent-key",
          ...agentIdentity,
        },
      },
    },
  } as Partial<ExternalIdentityProviderConfig>);
}

function mockIdJagResponse() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          access_token: "id-jag",
          issued_token_type: OAUTH_TOKEN_TYPE.IdJag,
          token_type: "N_A",
          expires_in: 300,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
}

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
