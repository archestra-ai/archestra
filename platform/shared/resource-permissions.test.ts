// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test } from "vitest";
import {
  canDelegateScopedPermissions,
  hasScopedPermission,
  ResourcePermissionScopeSchema,
  type ScopedPermission,
  widenToPreset,
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
    expect(widenToPreset(["use"], "log")).toEqual(["read"]);
  });
});
