import type { Permissions } from "@shared";
import { describe, expect, it } from "vitest";
import { formatMissingPermissions, hasPermissions } from "./auth.utils";

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
