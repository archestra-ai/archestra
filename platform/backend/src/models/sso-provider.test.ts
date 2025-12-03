import { describe, expect, test } from "@/test";
import SsoProviderModel from "./sso-provider";

describe("SsoProviderModel", () => {
  describe("findAllPublic", () => {
    test("returns empty array when no providers exist", async () => {
      const providers = await SsoProviderModel.findAllPublic();
      expect(providers).toEqual([]);
    });

    test("returns only id and providerId fields", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();

      await makeSsoProvider(org.id, {
        providerId: "Okta",
        oidcConfig: {
          clientId: "test-client-id",
          clientSecret: "super-secret-value",
          issuer: "https://okta.example.com",
          pkce: false,
          discoveryEndpoint: "https://okta.example.com/.well-known",
        },
      });

      const providers = await SsoProviderModel.findAllPublic();

      expect(providers).toHaveLength(1);
      expect(providers[0]).toHaveProperty("id");
      expect(providers[0]).toHaveProperty("providerId");
      expect(providers[0].providerId).toBe("Okta");

      // Verify sensitive fields are NOT included
      expect(providers[0]).not.toHaveProperty("oidcConfig");
      expect(providers[0]).not.toHaveProperty("samlConfig");
      expect(providers[0]).not.toHaveProperty("issuer");
      expect(providers[0]).not.toHaveProperty("domain");
      expect(providers[0]).not.toHaveProperty("organizationId");
    });

    test("returns multiple providers", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();

      await makeSsoProvider(org.id, { providerId: "Okta" });
      await makeSsoProvider(org.id, { providerId: "Google" });
      await makeSsoProvider(org.id, { providerId: "GitHub" });

      const providers = await SsoProviderModel.findAllPublic();

      expect(providers).toHaveLength(3);
      const providerIds = providers.map((p) => p.providerId);
      expect(providerIds).toContain("Okta");
      expect(providerIds).toContain("Google");
      expect(providerIds).toContain("GitHub");
    });
  });

  describe("findAll", () => {
    test("returns empty array when no providers exist", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const providers = await SsoProviderModel.findAll(org.id);
      expect(providers).toEqual([]);
    });

    test("returns full provider data including parsed oidcConfig", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const oidcConfig = {
        clientId: "test-client-id",
        clientSecret: "super-secret-value",
        issuer: "https://okta.example.com",
        pkce: false,
        discoveryEndpoint: "https://okta.example.com/.well-known",
        scopes: ["openid", "email", "profile"],
      };

      await makeSsoProvider(org.id, {
        providerId: "Okta",
        issuer: "https://okta.example.com",
        domain: "example.com",
        oidcConfig,
      });

      const providers = await SsoProviderModel.findAll(org.id);

      expect(providers).toHaveLength(1);
      expect(providers[0].providerId).toBe("Okta");
      expect(providers[0].issuer).toBe("https://okta.example.com");
      expect(providers[0].domain).toBe("example.com");
      expect(providers[0].oidcConfig).toEqual(oidcConfig);
      expect(providers[0].oidcConfig?.clientSecret).toBe("super-secret-value");
    });

    test("returns full provider data including parsed samlConfig", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const samlConfig = {
        issuer: "https://idp.example.com",
        entryPoint: "https://idp.example.com/sso",
        cert: "-----BEGIN CERTIFICATE-----\nSECRET\n-----END CERTIFICATE-----",
        callbackUrl: "https://app.example.com/callback",
        spMetadata: {},
      };

      await makeSsoProvider(org.id, {
        providerId: "SAML-Provider",
        samlConfig,
      });

      const providers = await SsoProviderModel.findAll(org.id);

      expect(providers).toHaveLength(1);
      expect(providers[0].samlConfig).toEqual(samlConfig);
      expect(providers[0].samlConfig?.cert).toContain("SECRET");
    });

    test("handles providers without oidcConfig or samlConfig", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();

      await makeSsoProvider(org.id, {
        providerId: "BasicProvider",
      });

      const providers = await SsoProviderModel.findAll(org.id);

      expect(providers).toHaveLength(1);
      expect(providers[0].oidcConfig).toBeUndefined();
      expect(providers[0].samlConfig).toBeUndefined();
    });

    test("only returns providers for the specified organization (multi-tenant isolation)", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      // Create providers for both organizations
      await makeSsoProvider(org1.id, {
        providerId: "Org1-Okta",
        oidcConfig: {
          clientId: "org1-client",
          clientSecret: "ORG1_SECRET",
          issuer: "https://org1.okta.com",
          pkce: false,
          discoveryEndpoint: "https://org1.okta.com/.well-known",
        },
      });
      await makeSsoProvider(org2.id, {
        providerId: "Org2-Okta",
        oidcConfig: {
          clientId: "org2-client",
          clientSecret: "ORG2_SECRET",
          issuer: "https://org2.okta.com",
          pkce: false,
          discoveryEndpoint: "https://org2.okta.com/.well-known",
        },
      });

      // Org1 should only see their own provider
      const org1Providers = await SsoProviderModel.findAll(org1.id);
      expect(org1Providers).toHaveLength(1);
      expect(org1Providers[0].providerId).toBe("Org1-Okta");
      expect(org1Providers[0].oidcConfig?.clientSecret).toBe("ORG1_SECRET");

      // Org2 should only see their own provider
      const org2Providers = await SsoProviderModel.findAll(org2.id);
      expect(org2Providers).toHaveLength(1);
      expect(org2Providers[0].providerId).toBe("Org2-Okta");
      expect(org2Providers[0].oidcConfig?.clientSecret).toBe("ORG2_SECRET");

      // Neither should see the other's secrets
      expect(JSON.stringify(org1Providers)).not.toContain("ORG2_SECRET");
      expect(JSON.stringify(org2Providers)).not.toContain("ORG1_SECRET");
    });
  });

  describe("findById", () => {
    test("returns null when provider does not exist", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const provider = await SsoProviderModel.findById(
        "non-existent-id",
        org.id,
      );
      expect(provider).toBeNull();
    });

    test("returns null when provider exists but belongs to different organization", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const inserted = await makeSsoProvider(org1.id, {
        providerId: "Okta",
      });

      // Try to find with wrong organization
      const provider = await SsoProviderModel.findById(inserted.id, org2.id);
      expect(provider).toBeNull();
    });

    test("returns provider when found with correct organization", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const oidcConfig = {
        clientId: "test-client-id",
        clientSecret: "secret",
        issuer: "https://okta.example.com",
        pkce: false,
        discoveryEndpoint: "https://okta.example.com/.well-known",
      };

      const inserted = await makeSsoProvider(org.id, {
        providerId: "Okta",
        issuer: "https://okta.example.com",
        oidcConfig,
      });

      const provider = await SsoProviderModel.findById(inserted.id, org.id);

      expect(provider).not.toBeNull();
      expect(provider?.id).toBe(inserted.id);
      expect(provider?.providerId).toBe("Okta");
      expect(provider?.oidcConfig).toEqual(oidcConfig);
    });
  });

  describe("update", () => {
    test("returns null when provider does not exist", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await SsoProviderModel.update(
        "non-existent-id",
        { issuer: "https://new-issuer.com" },
        org.id,
      );
      expect(result).toBeNull();
    });

    test("returns null when provider belongs to different organization", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const inserted = await makeSsoProvider(org1.id, {
        providerId: "Okta",
      });

      const result = await SsoProviderModel.update(
        inserted.id,
        { issuer: "https://new-issuer.com" },
        org2.id,
      );
      expect(result).toBeNull();
    });

    test("updates provider and returns updated data", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();

      const inserted = await makeSsoProvider(org.id, {
        providerId: "Okta",
        issuer: "https://old-issuer.com",
        domain: "old.example.com",
      });

      const updated = await SsoProviderModel.update(
        inserted.id,
        {
          issuer: "https://new-issuer.com",
          domain: "new.example.com",
        },
        org.id,
      );

      expect(updated).not.toBeNull();
      expect(updated?.issuer).toBe("https://new-issuer.com");
      expect(updated?.domain).toBe("new.example.com");
      expect(updated?.providerId).toBe("Okta"); // Unchanged
    });

    test("can update oidcConfig", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const initialOidcConfig = {
        clientId: "old-client-id",
        clientSecret: "old-secret",
        issuer: "https://old.example.com",
        pkce: false,
        discoveryEndpoint: "https://old.example.com/.well-known",
      };

      const inserted = await makeSsoProvider(org.id, {
        providerId: "Okta",
        oidcConfig: initialOidcConfig,
      });

      // The update method expects a JSON string for oidcConfig
      const newOidcConfig = JSON.stringify({
        clientId: "new-client-id",
        clientSecret: "new-secret",
        issuer: "https://new.example.com",
        pkce: true,
        discoveryEndpoint: "https://new.example.com/.well-known",
        scopes: ["openid", "email"],
      });

      const updated = await SsoProviderModel.update(
        inserted.id,
        // biome-ignore lint/suspicious/noExplicitAny: test uses raw string for DB update
        { oidcConfig: newOidcConfig as any },
        org.id,
      );

      expect(updated).not.toBeNull();
      expect(updated?.oidcConfig?.clientId).toBe("new-client-id");
      expect(updated?.oidcConfig?.clientSecret).toBe("new-secret");
    });
  });

  describe("delete", () => {
    test("returns false when provider does not exist", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await SsoProviderModel.delete("non-existent-id", org.id);
      expect(result).toBe(false);
    });

    test("returns false when provider belongs to different organization", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const inserted = await makeSsoProvider(org1.id, {
        providerId: "Okta",
      });

      const result = await SsoProviderModel.delete(inserted.id, org2.id);
      expect(result).toBe(false);

      // Verify provider still exists
      const provider = await SsoProviderModel.findById(inserted.id, org1.id);
      expect(provider).not.toBeNull();
    });

    test("deletes provider and returns true", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();

      const inserted = await makeSsoProvider(org.id, {
        providerId: "Okta",
      });

      // Verify it exists first
      const beforeDelete = await SsoProviderModel.findById(inserted.id, org.id);
      expect(beforeDelete).not.toBeNull();

      const result = await SsoProviderModel.delete(inserted.id, org.id);
      expect(result).toBe(true);

      // Verify it's deleted
      const afterDelete = await SsoProviderModel.findById(inserted.id, org.id);
      expect(afterDelete).toBeNull();
    });
  });

  describe("security: findAllPublic vs findAll", () => {
    test("findAllPublic does not expose clientSecret", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();

      await makeSsoProvider(org.id, {
        providerId: "Okta",
        oidcConfig: {
          clientId: "test-client-id",
          clientSecret: "THIS_IS_A_SECRET_VALUE",
          issuer: "https://okta.example.com",
          pkce: false,
          discoveryEndpoint: "https://okta.example.com/.well-known",
        },
      });

      const publicProviders = await SsoProviderModel.findAllPublic();
      const allProviders = await SsoProviderModel.findAll(org.id);

      // Public endpoint should NOT have any config
      expect(publicProviders[0]).not.toHaveProperty("oidcConfig");
      expect(JSON.stringify(publicProviders[0])).not.toContain(
        "THIS_IS_A_SECRET_VALUE",
      );

      // Full endpoint SHOULD have the secret
      expect(allProviders[0].oidcConfig?.clientSecret).toBe(
        "THIS_IS_A_SECRET_VALUE",
      );
    });

    test("findAllPublic returns minimal data structure", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();

      await makeSsoProvider(org.id, {
        providerId: "Okta",
        issuer: "https://okta.example.com",
        domain: "example.com",
        oidcConfig: {
          clientId: "id",
          clientSecret: "secret",
          issuer: "https://okta.example.com",
          pkce: false,
          discoveryEndpoint: "https://okta.example.com/.well-known",
          authorizationEndpoint: "https://auth.example.com",
          tokenEndpoint: "https://token.example.com",
        },
      });

      const publicProviders = await SsoProviderModel.findAllPublic();

      // Should only have exactly 2 keys
      const keys = Object.keys(publicProviders[0]);
      expect(keys).toHaveLength(2);
      expect(keys).toContain("id");
      expect(keys).toContain("providerId");
    });
  });

  /**
   * Test for domainVerified workaround.
   * With `domainVerification: { enabled: true }` in Better Auth's SSO plugin,
   * all SSO providers need `domainVerified: true` for sign-in to work.
   * See: https://github.com/better-auth/better-auth/issues/6481
   * TODO: Remove this test once the upstream issue is fixed.
   */
  describe("domainVerified workaround", () => {
    test("SAML providers are created with domainVerified: true", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();

      const samlProvider = await makeSsoProvider(org.id, {
        providerId: "SAML-Test",
        samlConfig: {
          issuer: "https://idp.example.com",
          entryPoint: "https://idp.example.com/sso",
          cert: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
          callbackUrl: "https://app.example.com/callback",
          spMetadata: {},
        },
      });

      const provider = await SsoProviderModel.findById(samlProvider.id, org.id);

      expect(provider).not.toBeNull();
      expect(provider?.domainVerified).toBe(true);
    });

    test("OIDC providers are created with domainVerified: true", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();

      const oidcProvider = await makeSsoProvider(org.id, {
        providerId: "OIDC-Test",
        oidcConfig: {
          clientId: "test-client",
          clientSecret: "test-secret",
          issuer: "https://idp.example.com",
          pkce: false,
          discoveryEndpoint: "https://idp.example.com/.well-known",
        },
      });

      const provider = await SsoProviderModel.findById(oidcProvider.id, org.id);

      expect(provider).not.toBeNull();
      // With domainVerification enabled, OIDC providers also need domainVerified: true
      expect(provider?.domainVerified).toBe(true);
    });
  });
});
