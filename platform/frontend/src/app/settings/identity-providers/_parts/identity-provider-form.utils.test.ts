import { type IdentityProviderFormValues, OAUTH_TOKEN_TYPE } from "@shared";
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
  it("clears allowed email domains for non-Google OIDC providers", () => {
    const normalized = normalizeIdentityProviderFormValues(
      makeOidcFormValues({
        providerId: "Okta",
        domain: "example.com",
      }),
    );

    expect(normalized.domain).toBe("");
  });

  it("keeps allowed email domains for Google providers", () => {
    const normalized = normalizeIdentityProviderFormValues(
      makeOidcFormValues({
        providerId: "Google",
        domain: "example.com",
      }),
    );

    expect(normalized.domain).toBe("example.com");
  });

  it("syncs the nested OIDC issuer with the visible issuer field", () => {
    const normalized = normalizeIdentityProviderFormValues(
      makeOidcFormValues({
        issuer: "https://integrator-8514409.okta.com",
        providerId: "Okta",
        oidcConfig: {
          issuer: "https://your-domain.okta.com",
          pkce: true,
          clientId: "client-id",
          clientSecret: "client-secret",
          discoveryEndpoint:
            "https://your-domain.okta.com/.well-known/openid-configuration",
          mapping: { id: "sub", email: "email", name: "name" },
        },
      }),
    );

    expect(normalized.oidcConfig?.issuer).toBe(
      "https://integrator-8514409.okta.com",
    );
    expect(normalized.oidcConfig?.discoveryEndpoint).toBe(
      "https://integrator-8514409.okta.com/.well-known/openid-configuration",
    );
  });

  it("keeps a custom discovery endpoint while syncing the nested OIDC issuer", () => {
    const normalized = normalizeIdentityProviderFormValues(
      makeOidcFormValues({
        issuer: "https://login.example.com",
        oidcConfig: {
          issuer: "https://old-login.example.com",
          pkce: true,
          clientId: "client-id",
          clientSecret: "client-secret",
          discoveryEndpoint:
            "https://discovery.example.com/.well-known/openid-configuration",
          mapping: { id: "sub", email: "email", name: "name" },
        },
      }),
    );

    expect(normalized.oidcConfig?.issuer).toBe("https://login.example.com");
    expect(normalized.oidcConfig?.discoveryEndpoint).toBe(
      "https://discovery.example.com/.well-known/openid-configuration",
    );
  });

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
        exchangeStrategy: "rfc8693",
        tokenEndpointAuthentication: "client_secret_post",
        subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
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
        exchangeStrategy: "rfc8693",
        tokenEndpointAuthentication: "client_secret_post",
        subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
      }),
    );
  });

  it("fills inferred Entra enterprise-managed defaults when the section is used", () => {
    const normalized = normalizeIdentityProviderFormValues(
      makeOidcFormValues({
        providerId: "EntraID",
        issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
        oidcConfig: {
          issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
          pkce: true,
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          userInfoEndpoint: "https://graph.microsoft.com/oidc/userinfo",
          discoveryEndpoint:
            "https://login.microsoftonline.com/test-tenant/v2.0/.well-known/openid-configuration",
          mapping: { id: "sub", email: "email", name: "name" },
          enterpriseManagedCredentials: {
            clientId: "archestra-oidc",
            clientSecret: "archestra-oidc-secret",
            tokenEndpoint:
              "https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token",
          },
        },
      }),
    );

    expect(normalized.oidcConfig?.enterpriseManagedCredentials).toEqual(
      expect.objectContaining({
        exchangeStrategy: "entra_obo",
        tokenEndpointAuthentication: "client_secret_post",
        subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
      }),
    );
    expect(normalized.oidcConfig?.userInfoEndpoint).toBeUndefined();
    expect(normalized.oidcConfig?.mapping?.email).toBe("preferred_username");
  });

  it("preserves custom Entra OBO email mappings", () => {
    const normalized = normalizeIdentityProviderFormValues(
      makeOidcFormValues({
        providerId: "EntraID",
        issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
        oidcConfig: {
          issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
          pkce: true,
          clientId: "archestra-oidc",
          clientSecret: "archestra-oidc-secret",
          userInfoEndpoint: "https://graph.microsoft.com/oidc/userinfo",
          discoveryEndpoint:
            "https://login.microsoftonline.com/test-tenant/v2.0/.well-known/openid-configuration",
          mapping: { id: "sub", email: "upn", name: "name" },
          enterpriseManagedCredentials: {
            exchangeStrategy: "entra_obo",
            clientId: "archestra-oidc",
          },
        },
      }),
    );

    expect(normalized.oidcConfig?.userInfoEndpoint).toBeUndefined();
    expect(normalized.oidcConfig?.mapping?.email).toBe("upn");
  });
});
