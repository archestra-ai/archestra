// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test } from "vitest";
import {
  canDelegateScopedPermissions,
  grantsAudience,
  hasScopedPermission,
  isManagedResource,
  isResourcePermissionScope,
  ManagedResourceSchema,
  type ResourcePermissionGrant,
  ResourcePermissionScopeSchema,
  type ScopedPermission,
  ScopedResourceSchema,
  widenToPreset,
  withoutWildcardCoveredGrants,
} from "./resource-permissions";

const engineering = "00000000-0000-4000-8000-000000000001";
const finance = "00000000-0000-4000-8000-000000000002";
const permission = (
  values: Partial<ScopedPermission> = {},
): ScopedPermission => ({
  organizationId: "organization-a",
  resource: "agent",
  scope: engineering,
  action: "read",
  ...values,
});

describe("scoped permission composition", () => {
  test("combining read and update on different objects does not cross scopes", () => {
    const grants = [
      permission({ action: "update" }),
      permission({ scope: finance }),
    ];
    expect(
      hasScopedPermission({
        grants,
        required: permission({ action: "update" }),
      }),
    ).toBe(true);
    expect(
      hasScopedPermission({
        grants,
        required: permission({ scope: finance, action: "update" }),
      }),
    ).toBe(false);
  });

  test("wildcard covers existing and new objects but not other resources or organizations", () => {
    const grants = [permission({ scope: "*" })];
    expect(
      hasScopedPermission({ grants, required: permission({ scope: finance }) }),
    ).toBe(true);
    expect(
      hasScopedPermission({
        grants,
        required: permission({ resource: "skill" }),
      }),
    ).toBe(false);
    expect(
      hasScopedPermission({
        grants,
        required: permission({ organizationId: "organization-b" }),
      }),
    ).toBe(false);
    expect(
      hasScopedPermission({
        grants,
        required: permission({ action: "delete" }),
      }),
    ).toBe(false);
  });

  test("an exact object grant cannot authorize an all-object request", () => {
    expect(
      hasScopedPermission({
        grants: [permission()],
        required: permission({ scope: "*" }),
      }),
    ).toBe(false);
  });

  test("delegation requires both the delegated action and permission management on its scope", () => {
    const read = permission();
    const manage = permission({ action: "manage-permissions" });
    expect(
      canDelegateScopedPermissions({
        grants: [read, manage],
        requested: [read],
      }),
    ).toBe(true);
    expect(
      canDelegateScopedPermissions({ grants: [manage], requested: [read] }),
    ).toBe(false);
    expect(
      canDelegateScopedPermissions({ grants: [read], requested: [read] }),
    ).toBe(false);
    expect(
      canDelegateScopedPermissions({
        grants: [read, manage],
        requested: [permission({ scope: "*" })],
      }),
    ).toBe(false);
    expect(
      canDelegateScopedPermissions({
        grants: [
          read,
          permission({ scope: finance, action: "manage-permissions" }),
        ],
        requested: [read],
      }),
    ).toBe(false);
  });

  test("rejects empty scopes and partial wildcard expressions", () => {
    for (const scope of ["", "teams:*", "agents:*", "00000000-*", "all"]) {
      expect(ResourcePermissionScopeSchema.safeParse(scope).success).toBe(
        false,
      );
    }
  });
});

describe("policy row checks", () => {
  test("the scope check accepts exactly what the scope schema accepts", () => {
    const scopes = [
      "*",
      "**",
      "",
      "teams:*",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      "5c92ce5b-af93-469A-B00b-c38af4e88629",
      "00000000-0000-4000-8000-000000000003",
      "5C92CE5B-AF93-469A-800B-C38AF4E88629",
      ...["0", "1", "4", "7", "8", "9", "f"].map(
        (version) => `5c92ce5b-af93-${version}69a-800b-c38af4e88629`,
      ),
      ...["0", "7", "8", "9", "a", "b", "c", "f"].map(
        (variant) => `5c92ce5b-af93-469a-${variant}00b-c38af4e88629`,
      ),
      "5c92ce5b-af93-469a-800b-c38af4e8862",
      "5c92ce5b-af93-469a-800b-c38af4e886299",
      "5c92ce5baf93469a800bc38af4e88629",
      " 5c92ce5b-af93-469a-800b-c38af4e88629",
    ];
    for (const scope of scopes) {
      expect([scope, isResourcePermissionScope(scope)]).toEqual([
        scope,
        ResourcePermissionScopeSchema.safeParse(scope).success,
      ]);
    }
  });

  test("the resource check accepts exactly the managed resources", () => {
    for (const resource of [...ScopedResourceSchema.options, "unknown", ""]) {
      expect([resource, isManagedResource(resource)]).toEqual([
        resource,
        ManagedResourceSchema.safeParse(resource).success,
      ]);
    }
  });
});

describe("withoutWildcardCoveredGrants", () => {
  test("drops single-object grants a wildcard covers and keeps the rest", () => {
    const wildcard = permission({ scope: "*" });
    const otherAction = permission({ action: "update" });
    const otherOrganization = permission({ organizationId: "organization-b" });
    expect(
      withoutWildcardCoveredGrants([
        permission(),
        permission({ scope: finance }),
        wildcard,
        otherAction,
        otherOrganization,
      ]),
    ).toEqual([wildcard, otherAction, otherOrganization]);
  });

  test("keeps single-chat sharing grants, which a wildcard does not cover", () => {
    const shareOne = permission({
      resource: "conversation",
      action: "manage-permissions",
    });
    const shareAll = permission({
      resource: "conversation",
      action: "manage-permissions",
      scope: "*",
    });
    expect(withoutWildcardCoveredGrants([shareOne, shareAll])).toEqual([
      shareOne,
      shareAll,
    ]);
  });
});

describe("widenToPreset", () => {
  test("keeps a set that is already a preset", () => {
    expect(widenToPreset(["read", "manage-permissions"], "auditLog")).toEqual([
      "read",
      "manage-permissions",
    ]);
    expect(widenToPreset(["use", "read"], "agent")).toEqual(["read", "use"]);
  });

  test("adds read to use alone", () => {
    expect(widenToPreset(["use"], "llmModel")).toEqual(["read", "use"]);
  });

  test("widens a set between presets to the larger one, adding delete", () => {
    expect(
      widenToPreset(
        ["read", "use", "update", "manage-permissions"],
        "llmModel",
      ),
    ).toEqual(["read", "use", "update", "delete", "manage-permissions"]);
  });

  test("drops actions the resource offers no preset for", () => {
    expect(
      widenToPreset(
        ["read", "use", "update", "delete", "manage-permissions"],
        "conversation",
      ),
    ).toEqual(["read", "manage-permissions"]);
    expect(widenToPreset(["use"], "log")).toEqual([]);
    expect(widenToPreset([], "agent")).toEqual([]);
  });
});

describe("grantsAudience", () => {
  const owner = "owner-user";
  const read = (subject: ResourcePermissionGrant["subject"]) => ({
    subject,
    actions: ["read" as const],
  });

  test("an organization or role grant is org", () => {
    expect(grantsAudience([read({ type: "organization", id: "*" })])).toBe(
      "org",
    );
    expect(grantsAudience([read({ type: "role", id: "role-1" })])).toBe("org");
  });

  test("a team grant is team, unless a role grant widens it to org", () => {
    expect(grantsAudience([read({ type: "team", id: "team-1" })])).toBe("team");
    expect(
      grantsAudience([
        read({ type: "team", id: "team-1" }),
        read({ type: "role", id: "role-1" }),
      ]),
    ).toBe("org");
  });

  test("people, service accounts, and the owner alone are personal", () => {
    expect(grantsAudience([], owner)).toBe("personal");
    expect(grantsAudience([read({ type: "user", id: owner })], owner)).toBe(
      "personal",
    );
    expect(
      grantsAudience([read({ type: "user", id: "someone-else" })], owner),
    ).toBe("personal");
    expect(
      grantsAudience([
        read({
          type: "serviceAccount",
          id: "00000000-0000-4000-8000-000000000003",
        }),
      ]),
    ).toBe("personal");
  });

  test("grants without read are ignored", () => {
    expect(
      grantsAudience([
        { subject: { type: "organization", id: "*" }, actions: ["use"] },
        { subject: { type: "team", id: "team-1" }, actions: ["update"] },
      ]),
    ).toBe("personal");
  });
});
