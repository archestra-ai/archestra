import type { Permissions } from "@archestra/shared";
import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { describe, expect, it } from "vitest";
import {
  formatMissingPermissions,
  formatPermissionConstraint,
  hasPagePermissions,
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

  it("grants only the actions a role holds, with no implied actions", () => {
    const userPermissions: Permissions = {
      mcpServerInstallation: ["read", "create", "update", "delete"],
    };
    expect(
      hasPermissions(userPermissions, {
        mcpServerInstallation: ["read", "create", "update", "delete"],
      }),
    ).toBe(true);
    expect(
      hasPermissions(userPermissions, {
        mcpServerInstallation: ["manage-deleted"],
      }),
    ).toBe(false);
  });
});

describe("formatMissingPermissions", () => {
  it("formats missing permissions using resource labels", () => {
    expect(
      formatMissingPermissions({
        team: ["read"],
        mcpGateway: ["update"],
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
        mcpGateway: ["update"],
      }),
    ).toBe(
      "Available to roles with the Teams (read), MCP Gateways (update) permissions",
    );
  });

  it("keeps a resource's several actions inside its own parentheses", () => {
    // One resource, so the noun stays singular however many actions it lists.
    expect(formatPermissionConstraint({ project: ["update", "delete"] })).toBe(
      "Available to roles with the Projects (update, delete) permission",
    );
  });
});

describe("scoped page discovery", () => {
  const capabilities = [
    {
      organizationId: "org-1",
      resource: "mcpRegistry" as const,
      scope: "00000000-0000-4000-8000-000000000001",
      action: "read" as const,
    },
  ];
  it("opens the resource page for an object-only reader without granting mutations", () => {
    expect(
      hasPagePermissions({
        userPermissions: {},
        required: { mcpRegistry: ["read"] },
        capabilities,
      }),
    ).toBe(true);
    expect(
      hasPagePermissions({
        userPermissions: {},
        required: { mcpRegistry: ["update"] },
        capabilities,
      }),
    ).toBe(false);
    expect(hasPermissions({}, { mcpRegistry: ["read"] })).toBe(false);
  });
  it("does not let a grant for another resource satisfy page access", () => {
    expect(
      hasPagePermissions({
        userPermissions: {},
        required: { agent: ["read"] },
        capabilities,
      }),
    ).toBe(false);
  });
  it("opens the service accounts page for someone granted one account", () => {
    // The settings page asks for `serviceAccount: ["read"]`, and a per-object
    // grantee holds no service-account role action at all. The page map's
    // resource key and the scoped resource name have to stay the same word for
    // this to resolve; if one is ever renamed without the other, the grantee is
    // told they have access and then shown a Forbidden page.
    const account = [
      {
        organizationId: "org-1",
        resource: "serviceAccount" as const,
        scope: "11111111-1111-4111-8111-111111111111",
        action: "read" as const,
      },
    ];
    expect(
      hasPagePermissions({
        userPermissions: {},
        required: requiredPagePermissionsMap["/settings/service-accounts"],
        capabilities: account,
      }),
    ).toBe(true);
    expect(hasPermissions({}, { serviceAccount: ["read"] })).toBe(false);
    // A grant on one account is discovery, not authority over the rest.
    expect(
      hasPagePermissions({
        userPermissions: {},
        required: { serviceAccount: ["update"] },
        capabilities: account,
      }),
    ).toBe(false);
  });
  it("still requires every other page permission", () => {
    const required: Permissions = { mcpRegistry: ["read"], team: ["read"] };
    expect(
      hasPagePermissions({ userPermissions: {}, required, capabilities }),
    ).toBe(false);
    expect(
      hasPagePermissions({
        userPermissions: { team: ["read"] },
        required,
        capabilities,
      }),
    ).toBe(true);
  });
});
