import { describe, expect, test } from "vitest";
import { IdentityProviderOidcConfigSchema } from "./identity-provider";

describe("IdentityProviderOidcConfigSchema", () => {
  test("accepts skipDiscovery with explicit endpoints", () => {
    const result = IdentityProviderOidcConfigSchema.parse({
      issuer: "http://id-jag.example.com/demo-idp",
      skipDiscovery: true,
      pkce: true,
      clientId: "gateway-client",
      clientSecret: "gateway-secret",
      authorizationEndpoint: "http://id-jag.example.com/demo-idp/authorize",
      discoveryEndpoint:
        "http://id-jag.example.com/demo-idp/.well-known/openid-configuration",
      tokenEndpoint: "http://id-jag.example.com/token",
      jwksEndpoint: "http://id-jag.example.com/demo-idp/jwks",
    });

    expect(result.skipDiscovery).toBe(true);
    expect(result.tokenEndpoint).toBe("http://id-jag.example.com/token");
  });
});
