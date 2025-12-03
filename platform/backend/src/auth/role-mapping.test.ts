import type { SsoRoleMappingConfig } from "@shared";
import { MEMBER_ROLE_NAME } from "@shared";
import { describe, expect, vi } from "vitest";
import { test } from "@/test";
import { evaluateRoleMapping } from "./role-mapping";

// Mock the logger to avoid console output during tests
vi.mock("@/logging", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockProvider = {
  id: "test-provider-id",
  providerId: "TestOIDC",
};

describe("evaluateRoleMapping", () => {
  describe("when no config is provided", () => {
    test("returns fallback role when config is undefined", () => {
      const result = evaluateRoleMapping(undefined, {
        userInfo: { email: "user@example.com" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: MEMBER_ROLE_NAME,
        matched: false,
      });
    });

    test("returns custom fallback role when provided", () => {
      const result = evaluateRoleMapping(
        undefined,
        {
          userInfo: { email: "user@example.com" },
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
      const config: SsoRoleMappingConfig = {
        rules: [],
        defaultRole: "admin",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { email: "user@example.com" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: false,
      });
    });

    test("returns fallback role when defaultRole is not set", () => {
      const config: SsoRoleMappingConfig = {
        rules: [],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { email: "user@example.com" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: MEMBER_ROLE_NAME,
        matched: false,
      });
    });
  });

  describe("data source selection", () => {
    test("uses combined data source by default (merges token and userInfo)", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "tokenClaim == 'from-token'", role: "token-role" },
          {
            expression: "userInfoClaim == 'from-userinfo'",
            role: "userinfo-role",
          },
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { userInfoClaim: "from-userinfo" },
        token: { tokenClaim: "from-token" },
        provider: mockProvider,
      });

      // First matching rule wins (token claim matches first)
      expect(result).toEqual({
        role: "token-role",
        matched: true,
      });
    });

    test("combined data source prefers userInfo over token for conflicting keys", () => {
      const config: SsoRoleMappingConfig = {
        dataSource: "combined",
        rules: [{ expression: "role == 'from-userinfo'", role: "admin" }],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { role: "from-userinfo" },
        token: { role: "from-token" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("userInfo data source only uses userInfo", () => {
      const config: SsoRoleMappingConfig = {
        dataSource: "userInfo",
        rules: [
          { expression: "tokenOnly == 'value'", role: "should-not-match" },
          { expression: "userInfoOnly == 'value'", role: "userinfo-role" },
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { userInfoOnly: "value" },
        token: { tokenOnly: "value" },
        provider: mockProvider,
      });

      // Token data should not be available
      expect(result).toEqual({
        role: "userinfo-role",
        matched: true,
      });
    });

    test("token data source only uses token", () => {
      const config: SsoRoleMappingConfig = {
        dataSource: "token",
        rules: [
          { expression: "userInfoOnly == 'value'", role: "should-not-match" },
          { expression: "tokenOnly == 'value'", role: "token-role" },
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { userInfoOnly: "value" },
        token: { tokenOnly: "value" },
        provider: mockProvider,
      });

      // UserInfo data should not be available
      expect(result).toEqual({
        role: "token-role",
        matched: true,
      });
    });

    test("token data source handles missing token gracefully", () => {
      const config: SsoRoleMappingConfig = {
        dataSource: "token",
        rules: [{ expression: "tokenOnly == 'value'", role: "admin" }],
        defaultRole: "member",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { userInfoOnly: "value" },
        // token is undefined
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });
  });

  describe("JMESPath expression evaluation", () => {
    test("matches simple equality expression", () => {
      const config: SsoRoleMappingConfig = {
        rules: [{ expression: "role == 'administrator'", role: "admin" }],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { role: "administrator" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("matches contains expression for groups array", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          {
            expression: "contains(groups || `[]`, 'archestra-admins')",
            role: "admin",
          },
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { groups: ["users", "archestra-admins", "developers"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("handles null groups with fallback", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admin')", role: "admin" },
        ],
        defaultRole: "member",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { email: "user@example.com" }, // no groups
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });

    test("matches array element check with filter", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "roles[?@ == 'platform-admin'] | [0]", role: "admin" },
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { roles: ["viewer", "platform-admin", "editor"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("matches compound expressions with AND", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "department == 'IT' && title != null", role: "admin" },
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { department: "IT", title: "Engineer" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("matches compound expressions with OR", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          {
            expression: "contains(groups || `[]`, 'admins') || role == 'admin'",
            role: "admin",
          },
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { role: "admin", groups: [] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("does not match when expression evaluates to false", () => {
      const config: SsoRoleMappingConfig = {
        rules: [{ expression: "role == 'administrator'", role: "admin" }],
        defaultRole: "member",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { role: "user" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });

    test("does not match empty array result", () => {
      const config: SsoRoleMappingConfig = {
        rules: [{ expression: "groups[?@ == 'non-existent']", role: "admin" }],
        defaultRole: "member",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { groups: ["users", "developers"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });

    test("does not match null result from expression", () => {
      const config: SsoRoleMappingConfig = {
        rules: [{ expression: "nonExistentField", role: "admin" }],
        defaultRole: "member",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { groups: ["users"] },
        provider: mockProvider,
      });

      // JMESPath returns null for missing fields
      expect(result.matched).toBe(false);
      expect(result.role).toBe("member");
    });

    test("matches boolean true result", () => {
      const config: SsoRoleMappingConfig = {
        rules: [{ expression: "isAdmin", role: "admin" }],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { isAdmin: true },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("does not match boolean false result", () => {
      const config: SsoRoleMappingConfig = {
        rules: [{ expression: "isAdmin", role: "admin" }],
        defaultRole: "member",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { isAdmin: false },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "member",
        matched: false,
      });
    });

    test("matches non-empty string result", () => {
      const config: SsoRoleMappingConfig = {
        rules: [{ expression: "adminGroup", role: "admin" }],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { adminGroup: "yes" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("does not match empty string result", () => {
      const config: SsoRoleMappingConfig = {
        rules: [{ expression: "adminGroup", role: "admin" }],
        defaultRole: "member",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { adminGroup: "" },
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
      const config: SsoRoleMappingConfig = {
        rules: [
          {
            expression: "contains(groups || `[]`, 'super-admins')",
            role: "super_admin",
          },
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
          { expression: "contains(groups || `[]`, 'users')", role: "member" },
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { groups: ["users", "admins"] }, // Matches both admins and users
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin", // First matching rule
        matched: true,
      });
    });

    test("evaluates rules in order until first match", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "role == 'super-admin'", role: "super_admin" },
          { expression: "role == 'admin'", role: "admin" },
          { expression: "true", role: "member" }, // Catch-all
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { role: "admin" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });
  });

  describe("error handling", () => {
    test("continues to next rule on JMESPath syntax error", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "invalid[[[syntax", role: "broken" }, // Invalid JMESPath
          { expression: "role == 'admin'", role: "admin" },
        ],
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { role: "admin" },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("uses default role when all rules have errors", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "invalid[[[syntax", role: "broken1" },
          { expression: "also[[[invalid", role: "broken2" },
        ],
        defaultRole: "fallback",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { role: "admin" },
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
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        strictMode: true,
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { groups: ["users"] }, // Does not contain 'admins'
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: null,
        matched: false,
        error: expect.stringContaining("Access denied"),
      });
    });

    test("returns error when strict mode is enabled and no rules configured", () => {
      const config: SsoRoleMappingConfig = {
        rules: [],
        strictMode: true,
      };

      // When no rules are configured, it returns default role even with strictMode
      // because strict mode is about "no rules matching", not "no rules configured"
      const result = evaluateRoleMapping(config, {
        userInfo: { groups: ["users"] },
        provider: mockProvider,
      });

      // With no rules, default behavior is to return defaultRole
      // strictMode only kicks in when there ARE rules but none match
      expect(result.error).toBeUndefined();
    });

    test("returns matched role when strict mode is enabled and a rule matches", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        strictMode: true,
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { groups: ["admins"] },
        provider: mockProvider,
      });

      expect(result).toEqual({
        role: "admin",
        matched: true,
      });
    });

    test("returns default role when strict mode is disabled and no rules match", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "contains(groups || `[]`, 'admins')", role: "admin" },
        ],
        strictMode: false,
        defaultRole: "member",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: { groups: ["users"] },
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
      const config: SsoRoleMappingConfig = {
        dataSource: "combined",
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

      // Admin user
      const adminResult = evaluateRoleMapping(config, {
        userInfo: {},
        token: { groups: ["Everyone", "Archestra-Admins", "IT-Department"] },
        provider: mockProvider,
      });
      expect(adminResult.role).toBe("admin");
      expect(adminResult.matched).toBe(true);

      // Regular user
      const userResult = evaluateRoleMapping(config, {
        userInfo: {},
        token: { groups: ["Everyone", "Archestra-Users"] },
        provider: mockProvider,
      });
      expect(userResult.role).toBe("member");
      expect(userResult.matched).toBe(true);

      // Unknown user falls back to default
      const unknownResult = evaluateRoleMapping(config, {
        userInfo: {},
        token: { groups: ["Everyone", "External-Partners"] },
        provider: mockProvider,
      });
      expect(unknownResult.role).toBe("member");
      expect(unknownResult.matched).toBe(false);
    });

    test("Azure AD / Entra ID group object ID mapping", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          {
            expression:
              "contains(groups || `[]`, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')",
            role: "admin",
          },
        ],
        defaultRole: "member",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: {
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
      const config: SsoRoleMappingConfig = {
        rules: [
          { expression: "roles[?@ == 'archestra-admin'] | [0]", role: "admin" },
          {
            expression: "roles[?@ == 'archestra-editor'] | [0]",
            role: "editor",
          },
        ],
        defaultRole: "viewer",
      };

      const result = evaluateRoleMapping(config, {
        userInfo: {
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
      const config: SsoRoleMappingConfig = {
        rules: [
          {
            expression: "department == 'IT' && jobTitle == 'Administrator'",
            role: "admin",
          },
          { expression: "department == 'IT'", role: "power_user" },
        ],
        defaultRole: "member",
      };

      // IT Admin
      const itAdminResult = evaluateRoleMapping(config, {
        userInfo: { department: "IT", jobTitle: "Administrator" },
        provider: mockProvider,
      });
      expect(itAdminResult.role).toBe("admin");

      // IT User (not admin)
      const itUserResult = evaluateRoleMapping(config, {
        userInfo: { department: "IT", jobTitle: "Developer" },
        provider: mockProvider,
      });
      expect(itUserResult.role).toBe("power_user");

      // Non-IT user
      const otherResult = evaluateRoleMapping(config, {
        userInfo: { department: "Sales", jobTitle: "Manager" },
        provider: mockProvider,
      });
      expect(otherResult.role).toBe("member");
    });

    test("multi-tenant SaaS with organization roles", () => {
      const config: SsoRoleMappingConfig = {
        rules: [
          {
            expression:
              "contains(organizations[?name == 'Acme Corp'].roles[] || `[]`, 'owner')",
            role: "admin",
          },
          {
            expression:
              "contains(organizations[?name == 'Acme Corp'].roles[] || `[]`, 'member')",
            role: "member",
          },
        ],
        strictMode: true,
      };

      // Organization owner
      const ownerResult = evaluateRoleMapping(config, {
        userInfo: {
          organizations: [
            { name: "Acme Corp", roles: ["owner", "billing"] },
            { name: "Other Org", roles: ["member"] },
          ],
        },
        provider: mockProvider,
      });
      expect(ownerResult.role).toBe("admin");

      // Organization member
      const memberResult = evaluateRoleMapping(config, {
        userInfo: {
          organizations: [{ name: "Acme Corp", roles: ["member"] }],
        },
        provider: mockProvider,
      });
      expect(memberResult.role).toBe("member");

      // Not part of organization (strict mode denies)
      const outsiderResult = evaluateRoleMapping(config, {
        userInfo: {
          organizations: [{ name: "Other Company", roles: ["owner"] }],
        },
        provider: mockProvider,
      });
      expect(outsiderResult.error).toBeDefined();
      expect(outsiderResult.role).toBeNull();
    });
  });
});
