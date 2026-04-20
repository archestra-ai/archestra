import { describe, expect, it } from "vitest";
import {
  emailMatchesAllowedIdentityProviderDomains,
  IdentityProviderFormSchema,
  IdentityProviderOidcConfigSchema,
} from "./identity-provider";

describe("IdentityProviderOidcConfigSchema", () => {
  it("accepts skipDiscovery with explicit endpoints", () => {
    const result = IdentityProviderOidcConfigSchema.parse({
      issuer: "http://id-jag.example.com/demo-idp",
      skipDiscovery: true,
      pkce: true,
      hd: "example.com",
      clientId: "gateway-client",
      clientSecret: "gateway-secret",
      authorizationEndpoint: "http://id-jag.example.com/demo-idp/authorize",
      discoveryEndpoint:
        "http://id-jag.example.com/demo-idp/.well-known/openid-configuration",
      tokenEndpoint: "http://id-jag.example.com/token",
      jwksEndpoint: "http://id-jag.example.com/demo-idp/jwks",
    });

    expect(result.skipDiscovery).toBe(true);
    expect(result.hd).toBe("example.com");
    expect(result.tokenEndpoint).toBe("http://id-jag.example.com/token");
  });

  it("accepts a single hosted domain hint", () => {
    const result = IdentityProviderOidcConfigSchema.safeParse({
      issuer: "https://accounts.google.com",
      pkce: true,
      hd: "example.com",
      clientId: "gateway-client",
      clientSecret: "gateway-secret",
      discoveryEndpoint:
        "https://accounts.google.com/.well-known/openid-configuration",
    });

    expect(result.success).toBe(true);
  });

  it("rejects comma-separated hosted domain hints", () => {
    const result = IdentityProviderOidcConfigSchema.safeParse({
      issuer: "https://accounts.google.com",
      pkce: true,
      hd: "example.com, subsidiary.example.com",
      clientId: "gateway-client",
      clientSecret: "gateway-secret",
      discoveryEndpoint:
        "https://accounts.google.com/.well-known/openid-configuration",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "Enter a single valid domain, for example company.com",
    );
  });

  it("rejects malformed hosted domain hints", () => {
    const result = IdentityProviderOidcConfigSchema.safeParse({
      issuer: "https://accounts.google.com",
      pkce: true,
      hd: "https://example.com/path",
      clientId: "gateway-client",
      clientSecret: "gateway-secret",
      discoveryEndpoint:
        "https://accounts.google.com/.well-known/openid-configuration",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "Enter a single valid domain, for example company.com",
    );
  });
});

describe("IdentityProviderFormSchema", () => {
  const validBase = {
    providerId: "Google",
    issuer: "https://accounts.google.com",
    providerType: "oidc" as const,
    oidcConfig: {
      issuer: "https://accounts.google.com",
      pkce: true,
      clientId: "client-id",
      clientSecret: "client-secret",
      discoveryEndpoint:
        "https://accounts.google.com/.well-known/openid-configuration",
      mapping: {
        id: "sub",
        email: "email",
        name: "name",
      },
    },
  };

  it("accepts comma-separated allowed email domains", () => {
    const result = IdentityProviderFormSchema.safeParse({
      ...validBase,
      domain: "example.com, subsidiary.example.com",
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid allowed email domains", () => {
    const result = IdentityProviderFormSchema.safeParse({
      ...validBase,
      domain: "example.com, https://evil.com/path",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "Enter valid comma-separated domains, for example company.com, subsidiary.com",
    );
  });
});

describe("emailMatchesAllowedIdentityProviderDomains", () => {
  it("matches exact allowed domains", () => {
    expect(
      emailMatchesAllowedIdentityProviderDomains(
        "user@example.com",
        "example.com",
      ),
    ).toBe(true);
  });

  it("matches subdomains of allowed domains", () => {
    expect(
      emailMatchesAllowedIdentityProviderDomains(
        "user@engineering.example.com",
        "example.com",
      ),
    ).toBe(true);
  });

  it("matches comma-separated allowed domains", () => {
    expect(
      emailMatchesAllowedIdentityProviderDomains(
        "user@subsidiary.com",
        "example.com, subsidiary.com",
      ),
    ).toBe(true);
  });

  it("rejects unrelated domains", () => {
    expect(
      emailMatchesAllowedIdentityProviderDomains(
        "user@other.com",
        "example.com",
      ),
    ).toBe(false);
  });

  it("does not match sibling suffixes", () => {
    expect(
      emailMatchesAllowedIdentityProviderDomains(
        "user@badexample.com",
        "example.com",
      ),
    ).toBe(false);
  });
});
