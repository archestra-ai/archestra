import type { IdentityProviderFormValues } from "@shared";
import { describe, expect, it } from "vitest";
import { normalizeIdentityProviderFormValues } from "./identity-provider-form.utils";

function makeOidcFormValues(
  overrides?: Partial<IdentityProviderFormValues>,
): IdentityProviderFormValues {
  return {
    providerId: "keycloak",
    issuer: "http://localhost:30081/realms/archestra",
    domain: "example.com",
    providerType: "oidc",
    oidcConfig: {
      issuer: "http://localhost:30081/realms/archestra",
      pkce: true,
      clientId: "archestra-oidc",
      clientSecret: "archestra-oidc-secret",
      discoveryEndpoint:
        "http://localhost:30081/realms/archestra/.well-known/openid-configuration",
      mapping: { id: "sub", email: "email", name: "name" },
      ...overrides?.oidcConfig,
    },
    ...overrides,
  };
}

describe("normalizeIdentityProviderFormValues", () => {
  it("fills inferred Keycloak enterprise-managed defaults when the section is used", () => {
    const normalized = normalizeIdentityProviderFormValues(
      makeOidcFormValues({
        oidcConfig: {
          issuer: "http://localhost:30081/realms/archestra",
          pkce: true,
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          discoveryEndpoint:
            "http://localhost:30081/realms/archestra/.well-known/openid-configuration",
          mapping: { id: "sub", email: "email", name: "name" },
          enterpriseManagedCredentials: {
            clientId: "archestra-oidc",
            clientSecret: "archestra-oidc-secret",
            tokenEndpoint:
              "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
          },
        },
      }),
    );

    expect(normalized.oidcConfig?.enterpriseManagedCredentials).toEqual(
      expect.objectContaining({
        providerType: "keycloak",
        tokenEndpointAuthentication: "client_secret_post",
        subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
      }),
    );
  });

  it("does not create enterprise-managed defaults when the section is unused", () => {
    const normalized = normalizeIdentityProviderFormValues(
      makeOidcFormValues({
        oidcConfig: {
          issuer: "http://localhost:30081/realms/archestra",
          pkce: true,
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          discoveryEndpoint:
            "http://localhost:30081/realms/archestra/.well-known/openid-configuration",
          mapping: { id: "sub", email: "email", name: "name" },
          enterpriseManagedCredentials: {},
        },
      }),
    );

    expect(normalized.oidcConfig?.enterpriseManagedCredentials).toEqual({});
  });

  it("does not infer Okta from an attacker-controlled issuer substring", () => {
    const normalized = normalizeIdentityProviderFormValues(
      makeOidcFormValues({
        providerId: "generic-oidc",
        issuer: "https://attacker.example/.okta.com/path",
        oidcConfig: {
          issuer: "https://attacker.example/.okta.com/path",
          pkce: true,
          clientId: "client-id",
          clientSecret: "client-secret",
          discoveryEndpoint:
            "https://attacker.example/.okta.com/.well-known/openid-configuration",
          mapping: { id: "sub", email: "email", name: "name" },
          enterpriseManagedCredentials: {
            clientId: "exchange-client",
          },
        },
      }),
    );

    expect(normalized.oidcConfig?.enterpriseManagedCredentials).toEqual(
      expect.objectContaining({
        providerType: "generic_oidc",
        tokenEndpointAuthentication: "private_key_jwt",
        subjectTokenType: "urn:ietf:params:oauth:token-type:id_token",
      }),
    );
  });
});
