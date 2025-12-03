import type { SsoRoleMappingConfig } from "@shared";
import { MEMBER_ROLE_NAME } from "@shared";
import { APIError } from "better-auth";
import { describe, expect, vi } from "vitest";
import { test } from "@/test";
import type { SsoGetRoleData } from "./better-auth";
import { resolveSsoRole } from "./better-auth";

// Mock the logger to avoid console output during tests
vi.mock("@/logging", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Helper to create test params with proper typing
function createParams(
  params: Partial<{
    user: { id: string; email: string } | null;
    token: Record<string, unknown>;
    provider: { providerId: string };
    userInfo: Record<string, unknown>;
  }>,
): SsoGetRoleData {
  return params as unknown as SsoGetRoleData;
}

describe("resolveSsoRole", () => {
  describe("when no SSO provider exists", () => {
    test("returns default member role", async () => {
      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: "NonExistentProvider" },
        userInfo: { email: "user@example.com" },
      });

      const result = await resolveSsoRole(params);

      expect(result).toBe(MEMBER_ROLE_NAME);
    });
  });

  describe("when SSO provider has no role mapping configured", () => {
    test("returns default member role", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const provider = await makeSsoProvider(org.id);

      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: provider.providerId },
        userInfo: { email: "user@example.com" },
      });

      const result = await resolveSsoRole(params);

      expect(result).toBe(MEMBER_ROLE_NAME);
    });
  });

  describe("role mapping with rules", () => {
    test("returns matched role when rule matches", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        defaultRole: "member",
      };
      const provider = await makeSsoProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "admin@example.com" },
        provider: { providerId: provider.providerId },
        userInfo: { groups: ["users", "admins"] },
      });

      const result = await resolveSsoRole(params);

      expect(result).toBe("admin");
    });

    test("returns default role when no rule matches", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        defaultRole: "viewer",
      };
      const provider = await makeSsoProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: provider.providerId },
        userInfo: { groups: ["users"] },
      });

      const result = await resolveSsoRole(params);

      expect(result).toBe("viewer");
    });

    test("uses token claims when data source is token", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: SsoRoleMappingConfig = {
        dataSource: "token",
        rules: [{ expression: "role == 'super-admin'", role: "admin" }],
        defaultRole: "member",
      };
      const provider = await makeSsoProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: provider.providerId },
        token: { role: "super-admin" },
        userInfo: { role: "regular-user" },
      });

      const result = await resolveSsoRole(params);

      expect(result).toBe("admin");
    });
  });

  describe("strict mode", () => {
    test("throws APIError when strict mode is enabled and no rules match", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        strictMode: true,
      };
      const provider = await makeSsoProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "user@example.com" },
        provider: { providerId: provider.providerId },
        userInfo: { groups: ["users"] },
      });

      await expect(resolveSsoRole(params)).rejects.toThrow(APIError);
      await expect(resolveSsoRole(params)).rejects.toThrow("Access denied");
    });

    test("returns role normally when strict mode is enabled and rule matches", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        strictMode: true,
      };
      const provider = await makeSsoProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "admin@example.com" },
        provider: { providerId: provider.providerId },
        userInfo: { groups: ["admins"] },
      });

      const result = await resolveSsoRole(params);

      expect(result).toBe("admin");
    });
  });

  describe("skip role sync", () => {
    test("returns existing role when skipRoleSync is enabled and user has membership", async ({
      makeOrganization,
      makeSsoProvider,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "viewer" });

      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        skipRoleSync: true,
      };
      const provider = await makeSsoProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: user.id, email: user.email },
        provider: { providerId: provider.providerId },
        userInfo: { groups: ["admins"] }, // Would normally map to admin
      });

      const result = await resolveSsoRole(params);

      // Should return existing role, not re-evaluate mapping
      expect(result).toBe("viewer");
    });

    test("evaluates rules when skipRoleSync is enabled but user has no membership (first login)", async ({
      makeOrganization,
      makeSsoProvider,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      // No membership created

      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        skipRoleSync: true,
      };
      const provider = await makeSsoProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: user.id, email: user.email },
        provider: { providerId: provider.providerId },
        userInfo: { groups: ["admins"] },
      });

      const result = await resolveSsoRole(params);

      // Should evaluate rules since this is first login
      expect(result).toBe("admin");
    });

    test("evaluates rules when skipRoleSync is disabled", async ({
      makeOrganization,
      makeSsoProvider,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "viewer" });

      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        skipRoleSync: false,
      };
      const provider = await makeSsoProvider(org.id, {
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: user.id, email: user.email },
        provider: { providerId: provider.providerId },
        userInfo: { groups: ["admins"] },
      });

      const result = await resolveSsoRole(params);

      // Should re-evaluate rules even though user has existing membership
      expect(result).toBe("admin");
    });
  });

  describe("real-world scenarios", () => {
    test("Okta groups claim mapping for admin", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          {
            expression: "contains(groups || `[]`, 'Archestra-Admins')",
            role: "admin",
          },
          {
            expression: "contains(groups || `[]`, 'Archestra-Users')",
            role: "member",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeSsoProvider(org.id, {
        providerId: "Okta",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "admin@company.com" },
        provider: { providerId: provider.providerId },
        token: { groups: ["Everyone", "Archestra-Admins", "IT-Department"] },
        userInfo: { email: "admin@company.com" },
      });

      const result = await resolveSsoRole(params);

      expect(result).toBe("admin");
    });

    test("Keycloak realm roles for editor", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          { expression: "roles[?@ == 'archestra-admin'] | [0]", role: "admin" },
          {
            expression: "roles[?@ == 'archestra-editor'] | [0]",
            role: "editor",
          },
        ],
        defaultRole: "viewer",
      };
      const provider = await makeSsoProvider(org.id, {
        providerId: "Keycloak",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "editor@company.com" },
        provider: { providerId: provider.providerId },
        userInfo: {
          roles: [
            "default-roles-myrealm",
            "archestra-editor",
            "offline_access",
          ],
        },
      });

      const result = await resolveSsoRole(params);

      expect(result).toBe("editor");
    });

    test("Azure AD group GUID mapping", async ({
      makeOrganization,
      makeSsoProvider,
    }) => {
      const org = await makeOrganization();
      const roleMapping: SsoRoleMappingConfig = {
        rules: [
          {
            expression:
              "contains(groups || `[]`, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')",
            role: "admin",
          },
        ],
        defaultRole: "member",
      };
      const provider = await makeSsoProvider(org.id, {
        providerId: "EntraID",
        roleMapping: roleMapping as unknown as Record<string, unknown>,
      });

      const params = createParams({
        user: { id: "user-1", email: "user@company.com" },
        provider: { providerId: provider.providerId },
        userInfo: {
          groups: [
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "f0e0d0c0-b0a0-9080-7060-504030201000",
          ],
        },
      });

      const result = await resolveSsoRole(params);

      expect(result).toBe("admin");
    });
  });
});
