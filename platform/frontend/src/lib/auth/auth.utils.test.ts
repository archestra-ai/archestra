import type { Permissions } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  formatMissingPermissions,
  formatPermissionConstraint,
  hasPermissions,
} from "./auth.utils";

describe("hasPermissions", () => {
  it("returns true when no permissions are required", () => {
    expect(hasPermissions(undefined, {})).toBe(true);
  });

  it("returns false when permissions are required but user permissions are missing", () => {
    const required: Permissions = {
      team: ["read"],
    };

    expect(hasPermissions(undefined, required)).toBe(false);
  });

  it("returns true when the user has all required permissions", () => {
    const userPermissions: Permissions = {
      team: ["read", "create"],
      agent: ["read"],
    };
    const required: Permissions = {
      team: ["read"],
      agent: ["read"],
    };

    expect(hasPermissions(userPermissions, required)).toBe(true);
  });

  it("returns false when the user is missing a required action", () => {
    const userPermissions: Permissions = {
      team: ["read"],
    };
    const required: Permissions = {
      team: ["read", "create"],
    };

    expect(hasPermissions(userPermissions, required)).toBe(false);
  });

  it("returns false when the user is missing an entire resource", () => {
    const userPermissions: Permissions = {
      team: ["read"],
    };
    const required: Permissions = {
      agent: ["read"],
    };

    expect(hasPermissions(userPermissions, required)).toBe(false);
  });
});

describe("formatMissingPermissions", () => {
  it("formats missing permissions using resource labels", () => {
    expect(
      formatMissingPermissions({
        team: ["read"],
        mcpGateway: ["team-admin"],
      }),
    ).toContain("Missing permissions:");
  });
});

describe("formatPermissionConstraint", () => {
  it("names the required permission with its resource label", () => {
    expect(formatPermissionConstraint({ skill: ["update"] })).toBe(
      "Available to roles with the Skills (update) permission",
    );
  });

  it("pluralises the noun once more than one resource is required", () => {
    expect(
      formatPermissionConstraint({
        team: ["read"],
        mcpGateway: ["team-admin"],
      }),
    ).toBe(
      "Available to roles with the Teams (read), MCP Gateways (team-admin) permissions",
    );
  });

  it("keeps a resource's several actions inside its own parentheses", () => {
    // One resource, so the noun stays singular however many actions it lists.
    expect(formatPermissionConstraint({ project: ["admin", "delete"] })).toBe(
      "Available to roles with the Projects (admin, delete) permission",
    );
  });
});
