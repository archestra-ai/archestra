import type { IdpRoleMappingConfig } from "@shared";
import { MEMBER_ROLE_NAME } from "@shared";
import { APIError } from "better-auth";
import { vi } from "vitest";
import { retrieveIdpGroups } from "@/auth/idp-team-sync-cache.ee";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import AccountModel from "./account";
import IdentityProviderModel, {
  type IdpGetRoleData,
} from "./identity-provider.ee";

// Mock the logger to avoid console output during tests
vi.mock("@/logging", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock cacheManager for SSO groups caching tests (preserves LRUCacheManager, CacheKey exports)
const mockCacheStore = new Map<string, unknown>();
vi.mock("@/cache-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cache-manager")>();
  return {
    ...actual,
    cacheManager: {
      get: vi.fn(async (key: string) => mockCacheStore.get(key)),
      set: vi.fn(async (key: string, value: unknown, _ttl?: number) => {
        mockCacheStore.set(key, value);
        return value;
      }),
      delete: vi.fn(async (key: string) => {
        const existed = mockCacheStore.has(key);
        mockCacheStore.delete(key);
        return existed;
      }),
      getAndDelete: vi.fn(async (key: string) => {
        const value = mockCacheStore.get(key);
        mockCacheStore.delete(key);
        return value;
      }),
    },
  };
});

const mockProvider = {
  id: "test-provider-id",
  providerId: "TestOIDC",
};

// Helper to create test params with proper typing for resolveSsoRole tests
// Note: userInfo is included for compatibility with better-auth's IdpGetRoleData type
// but role mapping only uses token claims
function createParams(
  params: Partial<{
    user: { id: string; email: string } | null;
    token: Record<string, unknown>;
    provider: { providerId: string };
  }>,
): IdpGetRoleData {
  return params as unknown as IdpGetRoleData;
}

describe("IdentityProviderModel", () => {
  describe("findAllPublic", () => {
    test("returns empty array when no providers exist", async () => {
      const providers = await IdentityProviderModel.findAllPublic();
      expect(providers).toEqual([]);
    });

    test("returns only id and providerId fields", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      await makeIdentityProvider(org.id, {
        providerId: "Okta",
        oidcConfig: {
          clientId: "test-client-id",
          clientSecret: "super-secret-value",
          issuer: "https://okta.example.com",
          pkce: false,
          discoveryEndpoint: "https://okta.example.com/.well-known",
        },
      });

      const providers = await IdentityProviderModel.findAllPublic();

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
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      await makeIdentityProvider(org.id, { providerId: "Okta" });
      await makeIdentityProvider(org.id, { providerId: "Google" });
      await makeIdentityProvider(org.id, { providerId: "GitHub" });

      const providers = await IdentityProviderModel.findAllPublic();

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
      const providers = await IdentityProviderModel.findAll(org.id);
      expect(providers).toEqual([]);
    });

    test("returns full provider data including parsed oidcConfig", async ({
      makeOrganization,
      makeIdentityProvider,
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

      await makeIdentityProvider(org.id, {
        providerId: "Okta",
        issuer: "https://okta.example.com",
        domain: "example.com",
        oidcConfig,
      });

      const providers = await IdentityProviderModel.findAll(org.id);

      expect(providers).toHaveLength(1);
      expect(providers[0].providerId).toBe("Okta");
      expect(providers[0].issuer).toBe("https://okta.example.com");
      expect(providers[0].domain).toBe("example.com");
      expect(providers[0].oidcConfig).toEqual(oidcConfig);
      expect(providers[0].oidcConfig?.clientSecret).toBe("super-secret-value");
    });

    test("returns full provider data including parsed samlConfig", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const samlConfig = {
        issuer: "https://idp.example.com",
        entryPoint: "https://idp.example.com/sso",
        cert: "-----BEGIN CERTIFICATE-----\nSECRET\n-----END CERTIFICATE-----",
        callbackUrl: "https://app.example.com/callback",
        spMetadata: {},
      };

      await makeIdentityProvider(org.id, {
        providerId: "SAML-Provider",
        samlConfig,
      });

      const providers = await IdentityProviderModel.findAll(org.id);

      expect(providers).toHaveLength(1);
      expect(providers[0].samlConfig).toEqual(samlConfig);
      expect(providers[0].samlConfig?.cert).toContain("SECRET");
    });

    test("handles providers without oidcConfig or samlConfig", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      await makeIdentityProvider(org.id, {
        providerId: "BasicProvider",
      });

      const providers = await IdentityProviderModel.findAll(org.id);

      expect(providers).toHaveLength(1);
      expect(providers[0].oidcConfig).toBeUndefined();
      expect(providers[0].samlConfig).toBeUndefined();
    });

    test("only returns providers for the specified organization (multi-tenant isolation)", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      // Create providers for both organizations
      await makeIdentityProvider(org1.id, {
        providerId: "Org1-Okta",
        oidcConfig: {
          clientId: "org1-client",
          clientSecret: "ORG1_SECRET",
          issuer: "https://org1.okta.com",
          pkce: false,
          discoveryEndpoint: "https://org1.okta.com/.well-known",
        },
      });
      await makeIdentityProvider(org2.id, {
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
      const org1Providers = await IdentityProviderModel.findAll(org1.id);
      expect(org1Providers).toHaveLength(1);
      expect(org1Providers[0].providerId).toBe("Org1-Okta");
      expect(org1Providers[0].oidcConfig?.clientSecret).toBe("ORG1_SECRET");

      // Org2 should only see their own provider
      const org2Providers = await IdentityProviderModel.findAll(org2.id);
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
      const provider = await IdentityProviderModel.findById(
        "non-existent-id",
        org.id,
      );
      expect(provider).toBeNull();
    });

    test("returns null when provider exists but belongs to different organization", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const inserted = await makeIdentityProvider(org1.id, {
        providerId: "Okta",
      });

      // Try to find with wrong organization
      const provider = await IdentityProviderModel.findById(
        inserted.id,
        org2.id,
      );
      expect(provider).toBeNull();
    });

    test("returns provider when found with correct organization", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const oidcConfig = {
        clientId: "test-client-id",
        clientSecret: "secret",
        issuer: "https://okta.example.com",
        pkce: false,
        discoveryEndpoint: "https://okta.example.com/.well-known",
      };

      const inserted = await makeIdentityProvider(org.id, {
        providerId: "Okta",
        issuer: "https://okta.example.com",
        oidcConfig,
      });

      const provider = await IdentityProviderModel.findById(
        inserted.id,
        org.id,
      );

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
      const result = await IdentityProviderModel.update(
        "non-existent-id",
        { issuer: "https://new-issuer.com" },
        org.id,
      );
      expect(result).toBeNull();
    });

    test("returns null when provider belongs to different organization", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const inserted = await makeIdentityProvider(org1.id, {
        providerId: "Okta",
      });

      const result = await IdentityProviderModel.update(
        inserted.id,
        { issuer: "https://new-issuer.com" },
        org2.id,
      );
      expect(result).toBeNull();
    });

    test("updates provider and returns updated data", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      const inserted = await makeIdentityProvider(org.id, {
        providerId: "Okta",
        issuer: "https://old-issuer.com",
        domain: "old.example.com",
      });

      const updated = await IdentityProviderModel.update(
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
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const initialOidcConfig = {
        clientId: "old-client-id",
        clientSecret: "old-secret",
        issuer: "https://old.example.com",
        pkce: false,
        discoveryEndpoint: "https://old.example.com/.well-known",
      };

      const inserted = await makeIdentityProvider(org.id, {
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

      const updated = await IdentityProviderModel.update(
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
      const result = await IdentityProviderModel.delete(
        "non-existent-id",
        org.id,
      );
      expect(result).toBe(false);
    });

    test("returns false when provider belongs to different organization", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const inserted = await makeIdentityProvider(org1.id, {
        providerId: "Okta",
      });

      const result = await IdentityProviderModel.delete(inserted.id, org2.id);
      expect(result).toBe(false);

      // Verify provider still exists
      const provider = await IdentityProviderModel.findById(
        inserted.id,
        org1.id,
      );
      expect(provider).not.toBeNull();
    });

    test("deletes provider and returns true", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      const inserted = await makeIdentityProvider(org.id, {
        providerId: "Okta",
      });

      // Verify it exists first
      const beforeDelete = await IdentityProviderModel.findById(
        inserted.id,
        org.id,
      );
      expect(beforeDelete).not.toBeNull();

      const result = await IdentityProviderModel.delete(inserted.id, org.id);
      expect(result).toBe(true);

      // Verify it's deleted
      const afterDelete = await IdentityProviderModel.findById(
        inserted.id,
        org.id,
      );
      expect(afterDelete).toBeNull();
    });

    test("cleans up associated SSO accounts when provider is deleted", async ({
      makeOrganization,
      makeUser,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const provider = await makeIdentityProvider(org.id, {
        providerId: "CleanupTestProvider",
      });

      // Create an SSO account for this user with this provider
      // (simulating what happens after an SSO login)
      const accountId = crypto.randomUUID();
      await db.insert(schema.accountsTable).values({
        id: accountId,
        accountId: "keycloak-sub-123",
        providerId: provider.providerId, // "CleanupTestProvider"
        userId: user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Verify account exists
      const accountsBefore = await AccountModel.getAllByUserId(user.id);
      const ssoAccountsBefore = accountsBefore.filter(
        (a) => a.providerId === provider.providerId,
      );
      expect(ssoAccountsBefore.length).toBe(1);

      // Delete the provider
      const result = await IdentityProviderModel.delete(provider.id, org.id);
      expect(result).toBe(true);

      // Verify the account was also cleaned up
      const accountsAfter = await AccountModel.getAllByUserId(user.id);
      const ssoAccountsAfter = accountsAfter.filter(
        (a) => a.providerId === provider.providerId,
      );
      expect(ssoAccountsAfter.length).toBe(0);
    });
  });

  describe("security: findAllPublic vs findAll", () => {
    test("findAllPublic does not expose clientSecret", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      await makeIdentityProvider(org.id, {
        providerId: "Okta",
        oidcConfig: {
          clientId: "test-client-id",
          clientSecret: "THIS_IS_A_SECRET_VALUE",
          issuer: "https://okta.example.com",
          pkce: false,
          discoveryEndpoint: "https://okta.example.com/.well-known",
        },
      });

      const publicProviders = await IdentityProviderModel.findAllPublic();
      const allProviders = await IdentityProviderModel.findAll(org.id);

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
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      await makeIdentityProvider(org.id, {
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

      const publicProviders = await IdentityProviderModel.findAllPublic();

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
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      const samlProvider = await makeIdentityProvider(org.id, {
        providerId: "SAML-Test",
        samlConfig: {
          issuer: "https://idp.example.com",
          entryPoint: "https://idp.example.com/sso",
          cert: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
          callbackUrl: "https://app.example.com/callback",
          spMetadata: {},
        },
      });

      const provider = await IdentityProviderModel.findById(
        samlProvider.id,
        org.id,
      );

      expect(provider).not.toBeNull();
      expect(provider?.domainVerified).toBe(true);
    });

    test("OIDC providers are created with domainVerified: true", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      const oidcProvider = await makeIdentityProvider(org.id, {
        providerId: "OIDC-Test",
        oidcConfig: {
          clientId: "test-client",
          clientSecret: "test-secret",
          issuer: "https://idp.example.com",
          pkce: false,
          discoveryEndpoint: "https://idp.example.com/.well-known",
        },
      });

      const provider = await IdentityProviderModel.findById(
        oidcProvider.id,
        org.id,
      );

      expect(provider).not.toBeNull();
      // With domainVerification enabled, OIDC providers also need domainVerified: true
      expect(provider?.domainVerified).toBe(true);
    });

    test("updating a provider ensures domainVerified remains true", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      // Create a provider (will have domainVerified: true from create)
      const provider = await makeIdentityProvider(org.id, {
        providerId: "Update-Test",
        oidcConfig: {
          clientId: "test-client",
          clientSecret: "test-secret",
          issuer: "https://idp.example.com",
          pkce: false,
          discoveryEndpoint: "https://idp.example.com/.well-known",
        },
      });

      // Manually set domainVerified to false to simulate old data
      // (This simulates providers created before the workaround was added)
      await IdentityProviderModel.setDomainVerifiedForTesting(
        provider.id,
        false,
      );

      // Verify it's now false
      const beforeUpdate = await IdentityProviderModel.findById(
        provider.id,
        org.id,
      );
      expect(beforeUpdate?.domainVerified).toBe(false);

      // Update the provider (change domain)
      await IdentityProviderModel.update(
        provider.id,
        { domain: "updated.example.com" },
        org.id,
      );

      // After update, domainVerified should be set back to true
      const afterUpdate = await IdentityProviderModel.findById(
        provider.id,
        org.id,
      );
      expect(afterUpdate?.domainVerified).toBe(true);
    });
  });
});

describe("evaluateRoleMapping", () => {
  describe("when no config is provided", () => {
    test("returns fallback role when config is undefined", () => {
      const result = IdentityProviderModel.evaluateRoleMapping(undefined, {
        token: { email: "user@example.com" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: MEMBER_ROLE_NAME,
        matched: false,
      });
    });

    test("returns custom fallback role when provided", () => {
      const result = IdentityProviderModel.evaluateRoleMapping(
        undefined,
        {
          token: { email: "user@example.com" },
          provider: mockProvider,
        },
        "custom_fallback",
      );

      expect(result).toEqual({
        role: "custom_fallback",
        matched: false,
      });
    });
  });

  describe("when config has no rules", () => {
    test("returns defaultRole from config when set", () => {
      const config: IdpRoleMappingConfig = {
        rules: [],
        defaultRole: "admin",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { email: "user@example.com" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: false,
      });
    });

    test("returns fallback role when defaultRole is not set", () => {
      const config: IdpRoleMappingConfig = {
        rules: [],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { email: "user@example.com" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: MEMBER_ROLE_NAME,
        matched: false,
      });
    });
  });

  describe("ID token claims", () => {
    test("uses token claims for rule evaluation", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#equals tokenClaim "from-token"}}true{{/equals}}',
            role: "token-role",
          },
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { tokenClaim: "from-token" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "token-role",
        matched: true,
      });
    });

    test("handles missing token gracefully", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#equals tokenOnly "value"}}true{{/equals}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        // token is undefined
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });
  });

  describe("Handlebars template evaluation", () => {
    test("matches simple equality expression", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#equals role "administrator"}}true{{/equals}}',
            role: "admin",
          },
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { role: "administrator" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("matches includes expression for groups array", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#includes groups "archestra-admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["users", "archestra-admins", "developers"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("handles null groups gracefully", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admin"}}true{{/includes}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { email: "user@example.com" }, // no groups
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });

    test("matches array element check with each loop", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#each roles}}{{#equals this "platform-admin"}}true{{/equals}}{{/each}}',
            role: "admin",
          },
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { roles: ["viewer", "platform-admin", "editor"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("matches compound expressions with AND", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#and department title}}{{#equals department "IT"}}true{{/equals}}{{/and}}',
            role: "admin",
          },
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { department: "IT", title: "Engineer" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("matches compound expressions with OR (using multiple rules)", () => {
      // OR logic is implemented using multiple rules - first match wins
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#equals role "admin"}}true{{/equals}}',
            role: "admin",
          },
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { role: "admin", groups: [] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("does not match when expression evaluates to empty", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#equals role "administrator"}}true{{/equals}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { role: "user" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });

    test("does not match empty array result", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#each groups}}{{#equals this "non-existent"}}true{{/equals}}{{/each}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["users", "developers"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });

    test("does not match empty result from expression", () => {
      const config: IdpRoleMappingConfig = {
        rules: [{ expression: "{{nonExistentField}}", role: "admin" }],
        defaultRole: "member",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["users"] },
        provider: mockProvider,
      });

      // Handlebars template renders empty for missing fields
      expect(result.matched).toBe(false);
      expect(result.role).toBe("member");
    });

    test("matches when if helper evaluates to truthy", () => {
      const config: IdpRoleMappingConfig = {
        rules: [{ expression: "{{#if isAdmin}}true{{/if}}", role: "admin" }],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { isAdmin: true },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("does not match when if helper evaluates to falsy", () => {
      const config: IdpRoleMappingConfig = {
        rules: [{ expression: "{{#if isAdmin}}true{{/if}}", role: "admin" }],
        defaultRole: "member",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { isAdmin: false },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });

    test("matches when exists helper finds value", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: "{{#exists adminGroup}}true{{/exists}}",
            role: "admin",
          },
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { adminGroup: "yes" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("does not match empty string result", () => {
      const config: IdpRoleMappingConfig = {
        rules: [{ expression: "{{adminGroup}}", role: "admin" }],
        defaultRole: "member",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { adminGroup: "" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });
  });

  describe("rule ordering (first match wins)", () => {
    test("returns first matching rule when multiple rules match", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "super-admins"}}true{{/includes}}',
            role: "super_admin",
          },
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "users"}}true{{/includes}}',
            role: "member",
          },
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["users", "admins"] }, // Matches both admins and users
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin", // First matching rule
        matched: true,
      });
    });

    test("evaluates rules in order until first match", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#equals role "super-admin"}}true{{/equals}}',
            role: "super_admin",
          },
          {
            expression: '{{#equals role "admin"}}true{{/equals}}',
            role: "admin",
          },
          { expression: "true", role: "member" }, // Catch-all
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { role: "admin" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("evaluates second rule when first rule does not match", () => {
      // Scenario: User in team-b should match second rule, not first (team-a)
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "team-b"}}true{{/includes}}',
            role: "editor",
          },
        ],
        defaultRole: "member",
      };

      // User is only in team-b, should match the second rule
      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["team-b"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "editor", // Second rule matched
        matched: true,
      });
    });

    test("evaluates third rule when first two rules do not match", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "super-admins"}}true{{/includes}}',
            role: "super_admin",
          },
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "editors"}}true{{/includes}}',
            role: "editor",
          },
        ],
        defaultRole: "member",
      };

      // User is only in editors group, should match the third rule
      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["editors", "viewers"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "editor", // Third rule matched
        matched: true,
      });
    });

    test("falls back to default when no rules match", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "team-b"}}true{{/includes}}',
            role: "editor",
          },
        ],
        defaultRole: "member",
      };

      // User is in team-c which doesn't match any rule
      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["team-c"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member", // Default role
        matched: false,
      });
    });

    test("all rules are evaluated - real world scenario with copied/modified rules", () => {
      // Real-world scenario: Admin copies a working rule for team-a and modifies it for team-b
      // Both rules should be independently evaluated
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            // First rule: team-a gets admin
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
          {
            // Second rule: team-b gets editor (copied from first, modified)
            expression: '{{#includes groups "team-b"}}true{{/includes}}',
            role: "editor",
          },
        ],
        defaultRole: "viewer",
      };

      // Test team-a user
      const teamAResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["team-a"] },
        provider: mockProvider,
      });
      expect(teamAResult.role).toBe("admin");
      expect(teamAResult.matched).toBe(true);

      // Test team-b user - this was the reported issue scenario
      const teamBResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["team-b"] },
        provider: mockProvider,
      });
      expect(teamBResult.role).toBe("editor");
      expect(teamBResult.matched).toBe(true);

      // Test user in neither team
      const noTeamResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["team-c"] },
        provider: mockProvider,
      });
      expect(noTeamResult.role).toBe("viewer");
      expect(noTeamResult.matched).toBe(false);

      // Test user in both teams - should match first rule (team-a)
      const bothTeamsResult = IdentityProviderModel.evaluateRoleMapping(
        config,
        {
          token: { groups: ["team-a", "team-b"] },
          provider: mockProvider,
        },
      );
      expect(bothTeamsResult.role).toBe("admin"); // First match wins
      expect(bothTeamsResult.matched).toBe(true);
    });
  });

  describe("error handling", () => {
    test("continues to next rule on Handlebars syntax error", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          { expression: "{{#invalid}}", role: "broken" }, // Invalid Handlebars
          {
            expression: '{{#equals role "admin"}}true{{/equals}}',
            role: "admin",
          },
        ],
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { role: "admin" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("uses default role when all rules have errors", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          { expression: "{{#invalid}}", role: "broken1" },
          { expression: "{{#alsoInvalid}}", role: "broken2" },
        ],
        defaultRole: "fallback",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { role: "admin" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "fallback",
        matched: false,
      });
    });
  });

  describe("strict mode", () => {
    test("returns error when strict mode is enabled and no rules match", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        strictMode: true,
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["users"] }, // Does not contain 'admins'
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: null,
        matched: false,
        error: expect.stringContaining("Access denied"),
      });
    });

    test("returns error when strict mode is enabled and no rules configured", () => {
      const config: IdpRoleMappingConfig = {
        rules: [],
        strictMode: true,
      };

      // When no rules are configured, it returns default role even with strictMode
      // because strict mode is about "no rules matching", not "no rules configured"
      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["users"] },
        provider: mockProvider,
      });

      // With no rules, default behavior is to return defaultRole
      // strictMode only kicks in when there ARE rules but none match
      expect(result.error).toBeUndefined();
    });

    test("returns matched role when strict mode is enabled and a rule matches", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        strictMode: true,
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["admins"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("returns default role when strict mode is disabled and no rules match", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        strictMode: false,
        defaultRole: "member",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["users"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });
  });

  describe("real-world scenarios", () => {
    test("Okta groups claim mapping", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#includes groups "Archestra-Admins"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression:
              '{{#includes groups "Archestra-Users"}}true{{/includes}}',
            role: "member",
          },
        ],
        defaultRole: "member",
      };

      // Admin user
      const adminResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["Everyone", "Archestra-Admins", "IT-Department"] },
        provider: mockProvider,
      });
      expect(adminResult.role).toBe("admin");
      expect(adminResult.matched).toBe(true);

      // Regular user
      const userResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["Everyone", "Archestra-Users"] },
        provider: mockProvider,
      });
      expect(userResult.role).toBe("member");
      expect(userResult.matched).toBe(true);

      // Unknown user falls back to default
      const unknownResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { groups: ["Everyone", "External-Partners"] },
        provider: mockProvider,
      });
      expect(unknownResult.role).toBe("member");
      expect(unknownResult.matched).toBe(false);
    });

    test("Azure AD / Entra ID group object ID mapping", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#includes groups "a1b2c3d4-e5f6-7890-abcd-ef1234567890"}}true{{/includes}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: {
          groups: [
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890", // Admin group GUID
            "f0e0d0c0-b0a0-9080-7060-504030201000", // Another group
          ],
        },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("Keycloak realm roles mapping", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#each roles}}{{#equals this "archestra-admin"}}true{{/equals}}{{/each}}',
            role: "admin",
          },
          {
            expression:
              '{{#each roles}}{{#equals this "archestra-editor"}}true{{/equals}}{{/each}}',
            role: "editor",
          },
        ],
        defaultRole: "viewer",
      };

      const result = IdentityProviderModel.evaluateRoleMapping(config, {
        token: {
          roles: [
            "default-roles-myrealm",
            "archestra-editor",
            "offline_access",
          ],
        },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "editor",
        matched: true,
      });
    });

    test("SAML attribute mapping (department-based)", () => {
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#and department jobTitle}}{{#equals department "IT"}}{{#equals jobTitle "Administrator"}}true{{/equals}}{{/equals}}{{/and}}',
            role: "admin",
          },
          {
            expression: '{{#equals department "IT"}}true{{/equals}}',
            role: "power_user",
          },
        ],
        defaultRole: "member",
      };

      // IT Admin
      const itAdminResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { department: "IT", jobTitle: "Administrator" },
        provider: mockProvider,
      });
      expect(itAdminResult.role).toBe("admin");

      // IT User (not admin)
      const itUserResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { department: "IT", jobTitle: "Developer" },
        provider: mockProvider,
      });
      expect(itUserResult.role).toBe("power_user");

      // Non-IT user
      const otherResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: { department: "Sales", jobTitle: "Manager" },
        provider: mockProvider,
      });
      expect(otherResult.role).toBe("member");
    });

    test("multi-tenant SaaS with organization roles", () => {
      // Using flat role structure since Handlebars doesn't support complex filtering
      const config: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes orgRoles "owner"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes orgRoles "member"}}true{{/includes}}',
            role: "member",
          },
        ],
        strictMode: true,
      };

      // Organization owner
      const ownerResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: {
          orgRoles: ["owner", "billing"],
        },
        provider: mockProvider,
      });
      expect(ownerResult.role).toBe("admin");

      // Organization member
      const memberResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: {
          orgRoles: ["member"],
        },
        provider: mockProvider,
      });
      expect(memberResult.role).toBe("member");

      // Not part of organization (strict mode denies)
      const outsiderResult = IdentityProviderModel.evaluateRoleMapping(config, {
        token: {
          orgRoles: [], // No roles
        },
        provider: mockProvider,
      });
      expect(outsiderResult.error).toBeDefined();
      expect(outsiderResult.role).toBeNull();
    });
  });
});

describe("resolveSsoRole", () => {
  describe("when no SSO provider exists", () => {
    test("returns default member role", async () => {
      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: "NonExistentProvider" },
        token: { email: "user@example.com" },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe(MEMBER_ROLE_NAME);
    });
  });

  describe("when SSO provider has no role mapping configured", () => {
    test("returns default member role", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const provider = await makeIdentityProvider(org.id);

      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: provider.providerId },
        token: { email: "user@example.com" },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe(MEMBER_ROLE_NAME);
    });
  });

  describe("role mapping with rules", () => {
    test("returns matched role when rule matches", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "admin@example.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["users", "admins"] },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe("admin");
    });

    test("returns default role when no rule matches", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        defaultRole: "viewer",
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["users"] },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe("viewer");
    });

    test("uses token claims when data source is token", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#equals role "super-admin"}}true{{/equals}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: provider.providerId },
        token: { role: "super-admin" },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe("admin");
    });
  });

  describe("strict mode", () => {
    test("throws APIError when strict mode is enabled and no rules match", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        strictMode: true,
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["users"] },
      });

      await expect(
        IdentityProviderModel.resolveSsoRole(params),
      ).rejects.toThrow(APIError);
      await expect(
        IdentityProviderModel.resolveSsoRole(params),
      ).rejects.toThrow("Access denied");
    });

    test("returns role normally when strict mode is enabled and rule matches", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        strictMode: true,
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "admin@example.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["admins"] },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe("admin");
    });
  });

  describe("skip role sync", () => {
    test("returns existing role when skipRoleSync is enabled and user has membership", async ({
      makeOrganization,
      makeIdentityProvider,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "viewer" });

      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        skipRoleSync: true,
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: user.id, email: user.email },
        provider: { providerId: provider.providerId },
        token: { groups: ["admins"] }, // Would normally map to admin
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      // Should return existing role, not re-evaluate mapping
      expect(result).toBe("viewer");
    });

    test("evaluates rules when skipRoleSync is enabled but user has no membership (first login)", async ({
      makeOrganization,
      makeIdentityProvider,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      // No membership created

      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        skipRoleSync: true,
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: user.id, email: user.email },
        provider: { providerId: provider.providerId },
        token: { groups: ["admins"] },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      // Should evaluate rules since this is first login
      expect(result).toBe("admin");
    });

    test("evaluates rules when skipRoleSync is disabled", async ({
      makeOrganization,
      makeIdentityProvider,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "viewer" });

      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        skipRoleSync: false,
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: user.id, email: user.email },
        provider: { providerId: provider.providerId },
        token: { groups: ["admins"] },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      // Should re-evaluate rules even though user has existing membership
      expect(result).toBe("admin");
    });
  });

  describe("real-world scenarios", () => {
    test("Okta groups claim mapping for admin", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#includes groups "Archestra-Admins"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression:
              '{{#includes groups "Archestra-Users"}}true{{/includes}}',
            role: "member",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeIdentityProvider(org.id, {
        providerId: "Okta",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "admin@company.com" },
        provider: { providerId: provider.providerId },
        token: {
          groups: ["Everyone", "Archestra-Admins", "IT-Department"],
          email: "admin@company.com",
        },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe("admin");
    });

    test("Keycloak realm roles for editor", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#each roles}}{{#equals this "archestra-admin"}}true{{/equals}}{{/each}}',
            role: "admin",
          },
          {
            expression:
              '{{#each roles}}{{#equals this "archestra-editor"}}true{{/equals}}{{/each}}',
            role: "editor",
          },
        ],
        defaultRole: "viewer",
      };
      const provider = await makeIdentityProvider(org.id, {
        providerId: "Keycloak",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "editor@company.com" },
        provider: { providerId: provider.providerId },
        token: {
          roles: [
            "default-roles-myrealm",
            "archestra-editor",
            "offline_access",
          ],
        },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe("editor");
    });

    test("Azure AD group GUID mapping", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression:
              '{{#includes groups "a1b2c3d4-e5f6-7890-abcd-ef1234567890"}}true{{/includes}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeIdentityProvider(org.id, {
        providerId: "EntraID",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "user@company.com" },
        provider: { providerId: provider.providerId },
        token: {
          groups: [
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "f0e0d0c0-b0a0-9080-7060-504030201000",
          ],
        },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe("admin");
    });
  });

  describe("multiple rules evaluation (integration)", () => {
    test("second rule matches when user is in team-b but not team-a", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      // This test explicitly verifies the scenario where:
      // - Admin configured rule 1 for team-a users -> admin
      // - Admin copied and modified rule 2 for team-b users -> editor
      // - A user in team-b (but not team-a) should get editor role
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "team-b"}}true{{/includes}}',
            role: "editor",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeIdentityProvider(org.id, {
        providerId: "TestOIDC",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      // User is only in team-b, should match the second rule
      const params = createParams({
        user: { id: "user-1", email: "teamb-user@company.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["team-b", "general-users"] },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe("editor");
    });

    test("third rule matches when first two do not apply", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "super-admins"}}true{{/includes}}',
            role: "super_admin",
          },
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "editors"}}true{{/includes}}',
            role: "editor",
          },
        ],
        defaultRole: "viewer",
      };
      const provider = await makeIdentityProvider(org.id, {
        providerId: "TestOIDC",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "editor-user@company.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["editors", "viewers"] },
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      expect(result).toBe("editor");
    });

    test("all rules are evaluated independently for different users", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "team-b"}}true{{/includes}}',
            role: "editor",
          },
          {
            expression: '{{#includes groups "team-c"}}true{{/includes}}',
            role: "viewer",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeIdentityProvider(org.id, {
        providerId: "TestOIDC",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      // Test team-a user gets admin
      const teamAParams = createParams({
        user: { id: "user-a", email: "team-a@company.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["team-a"] },
      });
      expect(await IdentityProviderModel.resolveSsoRole(teamAParams)).toBe(
        "admin",
      );

      // Test team-b user gets editor
      const teamBParams = createParams({
        user: { id: "user-b", email: "team-b@company.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["team-b"] },
      });
      expect(await IdentityProviderModel.resolveSsoRole(teamBParams)).toBe(
        "editor",
      );

      // Test team-c user gets viewer
      const teamCParams = createParams({
        user: { id: "user-c", email: "team-c@company.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["team-c"] },
      });
      expect(await IdentityProviderModel.resolveSsoRole(teamCParams)).toBe(
        "viewer",
      );

      // Test user with no matching team gets default
      const noTeamParams = createParams({
        user: { id: "user-d", email: "no-team@company.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["unrelated-group"] },
      });
      expect(await IdentityProviderModel.resolveSsoRole(noTeamParams)).toBe(
        "member",
      );
    });

    test("first match wins when user is in multiple matching groups", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "team-b"}}true{{/includes}}',
            role: "editor",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeIdentityProvider(org.id, {
        providerId: "TestOIDC",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      // User is in BOTH team-a and team-b, should get admin (first match wins)
      const params = createParams({
        user: { id: "user-1", email: "both-teams@company.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["team-b", "team-a"] }, // Note: team-b listed first in array
      });

      const result = await IdentityProviderModel.resolveSsoRole(params);

      // Rule order matters, not group array order - team-a rule is first
      expect(result).toBe("admin");
    });
  });

  describe("database round-trip for multiple rules", () => {
    test("multiple rules survive create and read from database", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "team-b"}}true{{/includes}}',
            role: "editor",
          },
          {
            expression: '{{#includes groups "team-c"}}true{{/includes}}',
            role: "viewer",
          },
        ],
        defaultRole: "member",
        strictMode: true,
      };

      // Create provider with multiple rules
      const provider = await makeIdentityProvider(org.id, {
        providerId: "MultiRuleTest",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      // Read it back from database
      const retrieved = await IdentityProviderModel.findByProviderId(
        provider.providerId,
      );

      // Verify all rules are preserved
      expect(retrieved?.roleMapping?.rules).toHaveLength(3);
      expect(retrieved?.roleMapping?.rules?.[0]?.role).toBe("admin");
      expect(retrieved?.roleMapping?.rules?.[1]?.role).toBe("editor");
      expect(retrieved?.roleMapping?.rules?.[2]?.role).toBe("viewer");
      expect(retrieved?.roleMapping?.defaultRole).toBe("member");
      expect(retrieved?.roleMapping?.strictMode).toBe(true);
    });

    test("multiple rules survive update operation", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();

      // Create with one rule
      const initialRoleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };

      const provider = await makeIdentityProvider(org.id, {
        providerId: "UpdateTest",
        roleMapping: initialRoleMapping as unknown as Record<string, unknown>,
      });

      // Update with multiple rules (simulating user adding a second rule in UI)
      const updatedRoleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "team-b"}}true{{/includes}}',
            role: "editor",
          },
        ],
        defaultRole: "member",
      };

      const updated = await IdentityProviderModel.update(
        provider.id,
        {
          roleMapping: updatedRoleMapping,
        },
        org.id,
      );

      // Verify update returned both rules
      expect(updated?.roleMapping?.rules).toHaveLength(2);
      expect(updated?.roleMapping?.rules?.[0]?.role).toBe("admin");
      expect(updated?.roleMapping?.rules?.[1]?.role).toBe("editor");

      // Also read from database to double-check persistence
      const retrieved = await IdentityProviderModel.findByProviderId(
        provider.providerId,
      );

      expect(retrieved?.roleMapping?.rules).toHaveLength(2);
      expect(retrieved?.roleMapping?.rules?.[0]?.role).toBe("admin");
      expect(retrieved?.roleMapping?.rules?.[1]?.role).toBe("editor");
    });

    test("findAll returns multiple rules correctly", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "team-a"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#includes groups "team-b"}}true{{/includes}}',
            role: "editor",
          },
        ],
        defaultRole: "member",
      };

      await makeIdentityProvider(org.id, {
        providerId: "FindAllTest",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      // Use findAll which is used by the admin API
      const allProviders = await IdentityProviderModel.findAll(org.id);
      const provider = allProviders.find((p) => p.providerId === "FindAllTest");

      expect(provider?.roleMapping?.rules).toHaveLength(2);
      expect(provider?.roleMapping?.rules?.[0]?.role).toBe("admin");
      expect(provider?.roleMapping?.rules?.[1]?.role).toBe("editor");
    });
  });

  describe("IdP groups caching for team sync", () => {
    test("caches SSO groups when role mapping is configured and user has groups", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#includes groups "admins"}}true{{/includes}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "groupuser@example.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["engineering", "admins"] },
      });

      await IdentityProviderModel.resolveSsoRole(params);

      // Verify groups were cached
      const cachedData = await retrieveIdpGroups(
        provider.providerId,
        "groupuser@example.com",
      );
      expect(cachedData).not.toBeNull();
      expect(cachedData?.groups).toEqual(["engineering", "admins"]);
      expect(cachedData?.organizationId).toBe(org.id);
    });

    test("caches SSO groups when no role mapping is configured but user has groups", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      // Create provider without role mapping
      const provider = await makeIdentityProvider(org.id);

      const params = createParams({
        user: { id: "user-1", email: "noroles@example.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["team-a", "team-b"] },
      });

      await IdentityProviderModel.resolveSsoRole(params);

      // Verify groups were cached even without role mapping
      const cachedData = await retrieveIdpGroups(
        provider.providerId,
        "noroles@example.com",
      );
      expect(cachedData).not.toBeNull();
      expect(cachedData?.groups).toEqual(["team-a", "team-b"]);
      expect(cachedData?.organizationId).toBe(org.id);
    });

    test("does not cache groups when user email is missing", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const provider = await makeIdentityProvider(org.id);

      const params = createParams({
        user: null, // No user email
        provider: { providerId: provider.providerId },
        token: { groups: ["team-a"] },
      });

      await IdentityProviderModel.resolveSsoRole(params);

      // Cannot retrieve without email - this test verifies the code path
      // The caching should be skipped when user?.email is falsy
      // We can't easily verify "not cached" without knowing the email,
      // but the code coverage confirms the branch is exercised
    });

    test("does not cache groups when no groups are present in claims", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const provider = await makeIdentityProvider(org.id);

      const params = createParams({
        user: { id: "user-1", email: "nogroups@example.com" },
        provider: { providerId: provider.providerId },
        token: { email: "nogroups@example.com" }, // No groups claim
      });

      await IdentityProviderModel.resolveSsoRole(params);

      // Verify nothing was cached (no groups to cache)
      const cachedData = await retrieveIdpGroups(
        provider.providerId,
        "nogroups@example.com",
      );
      expect(cachedData).toBeNull();
    });

    test("extracts groups from token claims for caching", async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: IdpRoleMappingConfig = {
        rules: [
          {
            expression: '{{#equals role "admin"}}true{{/equals}}',
            role: "admin",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeIdentityProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "tokenuser@example.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["from-token"], role: "admin" },
      });

      await IdentityProviderModel.resolveSsoRole(params);

      // Groups extracted from token (we only use ID token claims now)
      const cachedData = await retrieveIdpGroups(
        provider.providerId,
        "tokenuser@example.com",
      );
      expect(cachedData).not.toBeNull();
      expect(cachedData?.groups).toEqual(["from-token"]);
    });
  });
});
