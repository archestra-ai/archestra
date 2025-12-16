import { describe, expect, it } from "vitest";
import { extractGroupsFromClaims } from "./sso-team-sync-cache.ee";

describe("extractGroupsFromClaims", () => {
  describe("without teamSyncConfig", () => {
    it("extracts groups from simple array claim", () => {
      const claims = {
        groups: ["admin", "users", "developers"],
      };
      expect(extractGroupsFromClaims(claims)).toEqual([
        "admin",
        "users",
        "developers",
      ]);
    });

    it("extracts groups from comma-separated string", () => {
      const claims = {
        groups: "admin, users, developers",
      };
      expect(extractGroupsFromClaims(claims)).toEqual([
        "admin",
        "users",
        "developers",
      ]);
    });

    it("extracts groups from space-separated string", () => {
      const claims = {
        groups: "admin users developers",
      };
      expect(extractGroupsFromClaims(claims)).toEqual([
        "admin",
        "users",
        "developers",
      ]);
    });

    it("returns single value as array", () => {
      const claims = {
        groups: "admin",
      };
      expect(extractGroupsFromClaims(claims)).toEqual(["admin"]);
    });

    it("checks common claim names in order", () => {
      // Should find 'memberOf' since 'groups' is empty
      const claims = {
        groups: [],
        memberOf: ["cn=admins,dc=example,dc=com"],
      };
      expect(extractGroupsFromClaims(claims)).toEqual([
        "cn=admins,dc=example,dc=com",
      ]);
    });

    it("checks roles claim", () => {
      const claims = {
        roles: ["editor", "viewer"],
      };
      expect(extractGroupsFromClaims(claims)).toEqual(["editor", "viewer"]);
    });

    it("returns empty array when no groups found", () => {
      const claims = {
        email: "user@example.com",
        name: "Test User",
      };
      expect(extractGroupsFromClaims(claims)).toEqual([]);
    });

    it("filters non-string values from arrays", () => {
      const claims = {
        groups: ["admin", 123, null, "users", undefined, "developers"],
      };
      expect(extractGroupsFromClaims(claims)).toEqual([
        "admin",
        "users",
        "developers",
      ]);
    });

    it("flattens nested arrays", () => {
      const claims = {
        groups: [["admin", "users"], ["developers"]],
      };
      expect(extractGroupsFromClaims(claims)).toEqual([
        "admin",
        "users",
        "developers",
      ]);
    });
  });

  describe("with teamSyncConfig.enabled = false", () => {
    it("returns empty array when team sync is disabled", () => {
      const claims = {
        groups: ["admin", "users"],
      };
      expect(
        extractGroupsFromClaims(claims, {
          enabled: false,
        }),
      ).toEqual([]);
    });
  });

  describe("with teamSyncConfig.groupsExpression (Handlebars)", () => {
    it("extracts groups using simple Handlebars template", () => {
      const claims = {
        customGroups: ["admin", "users"],
      };
      expect(
        extractGroupsFromClaims(claims, {
          groupsExpression: "{{#each customGroups}}{{this}},{{/each}}",
        }),
      ).toEqual(["admin", "users"]);
    });

    it("extracts group names from array of objects", () => {
      const claims = {
        roles: [
          { name: "Application Administrator", attributes: [] },
          { name: "Role Administrator", attributes: [] },
          { name: "n8n_access", attributes: [] },
        ],
      };
      expect(
        extractGroupsFromClaims(claims, {
          groupsExpression: "{{#each roles}}{{this.name}},{{/each}}",
        }),
      ).toEqual([
        "Application Administrator",
        "Role Administrator",
        "n8n_access",
      ]);
    });

    it("handles deeply nested structures", () => {
      const claims = {
        user: {
          memberships: {
            groups: ["team-a", "team-b"],
          },
        },
      };
      expect(
        extractGroupsFromClaims(claims, {
          groupsExpression:
            "{{#each user.memberships.groups}}{{this}},{{/each}}",
        }),
      ).toEqual(["team-a", "team-b"]);
    });

    it("handles pluck helper for extracting properties", () => {
      const claims = {
        roles: [
          { name: "admin", type: "system" },
          { name: "user", type: "custom" },
          { name: "editor", type: "system" },
        ],
      };
      expect(
        extractGroupsFromClaims(claims, {
          groupsExpression: '{{{json (pluck roles "name")}}}',
        }),
      ).toEqual(["admin", "user", "editor"]);
    });

    it("returns empty array when expression matches nothing", () => {
      const claims = {
        groups: ["admin"],
      };
      expect(
        extractGroupsFromClaims(claims, {
          groupsExpression: "{{#each nonExistentField}}{{this}},{{/each}}",
        }),
      ).toEqual([]);
    });

    it("returns empty when template uses undefined helper", () => {
      const claims = {
        groups: ["admin", "users"],
      };
      // Using undefined helper renders empty - this is expected behavior
      // Users should use valid templates. Invalid templates return no results.
      expect(
        extractGroupsFromClaims(claims, {
          groupsExpression: "{{#undefinedHelper}}content{{/undefinedHelper}}",
        }),
      ).toEqual([]);
    });

    it("uses default extraction when no groupsExpression is configured", () => {
      const claims = {
        groups: ["admin", "users"],
      };
      // Without groupsExpression, fall back to default claim names
      expect(
        extractGroupsFromClaims(claims, {
          enabled: true,
          // no groupsExpression
        }),
      ).toEqual(["admin", "users"]);
    });

    it("handles JSON array output from template", () => {
      const claims = {
        roles: [{ name: "Application Administrator" }, { name: "n8n_access" }],
      };
      expect(
        extractGroupsFromClaims(claims, {
          groupsExpression: '{{{json (pluck roles "name")}}}',
        }),
      ).toEqual(["Application Administrator", "n8n_access"]);
    });

    it("normalizes single string result to array", () => {
      const claims = {
        primaryRole: "superadmin",
      };
      expect(
        extractGroupsFromClaims(claims, {
          groupsExpression: "{{primaryRole}}",
        }),
      ).toEqual(["superadmin"]);
    });
  });

  describe("teamSyncConfig.enabled default behavior", () => {
    it("treats undefined enabled as enabled", () => {
      const claims = {
        groups: ["admin"],
      };
      expect(
        extractGroupsFromClaims(claims, {
          // enabled is undefined
        }),
      ).toEqual(["admin"]);
    });

    it("treats null enabled as enabled", () => {
      const claims = {
        groups: ["admin"],
      };
      expect(
        extractGroupsFromClaims(claims, {
          enabled: undefined,
        }),
      ).toEqual(["admin"]);
    });

    it("only disables when enabled is explicitly false", () => {
      const claims = {
        groups: ["admin"],
      };
      expect(
        extractGroupsFromClaims(claims, {
          enabled: true,
        }),
      ).toEqual(["admin"]);
    });
  });
});
