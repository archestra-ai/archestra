import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  emailMatchesAllowedIdentityProviderDomains,
  IDENTITY_PROVIDER_SECRET_PATHS,
  IdentityProviderFormSchema,
  IdentityProviderOidcConfigSchema,
  IdentityProviderSamlConfigSchema,
  RedactedIdentityProviderOidcConfigSchema,
  RedactedIdentityProviderSamlConfigSchema,
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

  it("accepts empty allowed email domains", () => {
    const result = IdentityProviderFormSchema.safeParse({
      ...validBase,
      domain: "",
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

describe("IDENTITY_PROVIDER_SECRET_PATHS", () => {
  /**
   * Walks a config schema by dot path, unwrapping optionals, and returns
   * whether the leaf exists.
   *
   * A path that no longer resolves — a typo, or a field renamed in the config
   * schema — makes the redactor quietly skip that credential and keep shipping
   * it to the browser. Nothing else fails in that case: the route tests only
   * cover the fields their fixtures populate.
   */
  function pathExists(schema: z.ZodType, path: string[]): boolean {
    let current: z.ZodType = schema;
    for (const segment of path) {
      const unwrapped = unwrapSchema(current);
      if (!(unwrapped instanceof z.ZodObject)) return false;
      const next: z.ZodType | undefined = unwrapped.shape[segment];
      if (!next) return false;
      current = next;
    }
    return true;
  }

  function unwrapSchema(schema: z.ZodType): z.ZodType {
    let current = schema;
    while (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable
    ) {
      current = current.unwrap() as z.ZodType;
    }
    return current;
  }

  it.each(
    IDENTITY_PROVIDER_SECRET_PATHS,
  )("%s resolves to a real config field", (path) => {
    const [root, ...rest] = path.split(".");
    const schema =
      root === "oidcConfig"
        ? IdentityProviderOidcConfigSchema
        : IdentityProviderSamlConfigSchema;

    expect(pathExists(schema, rest)).toBe(true);
  });

  it("leaves a fully redacted config parseable by the redacted schemas", () => {
    // Guards the write path: reads strip these fields, so if one of them ever
    // becomes required the edit form's PUT starts failing validation.
    expect(() =>
      RedactedIdentityProviderOidcConfigSchema.parse({
        issuer: "https://idp.example.com",
        pkce: true,
        clientId: "client",
        discoveryEndpoint:
          "https://idp.example.com/.well-known/openid-configuration",
        enterpriseManagedCredentials: {},
      }),
    ).not.toThrow();

    expect(() =>
      RedactedIdentityProviderSamlConfigSchema.parse({
        issuer: "https://saml.example.com",
        entryPoint: "https://saml.example.com/sso",
        cert: "public-cert",
        callbackUrl: "https://app.example.com/callback",
        spMetadata: {},
        idpMetadata: {},
      }),
    ).not.toThrow();
  });
});
