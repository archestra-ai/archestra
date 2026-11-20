import {
  allAvailableActions,
  predefinedPermissionsMap,
} from "@archestra/shared/access-control";
import { fixedRoleGroups } from "@archestra/shared/fixed-roles";
import { describe, expect, it } from "vitest";
import { allPermissionRows } from "./permission-list-model.ee";

/**
 * Resources the auth library checks on its own and nobody is granted by
 * hand, so they are never listed: see `allAvailableActions`.
 */
const INTERNAL_RESOURCES = new Set(["organization", "invitation"]);

const labels = new Map(allPermissionRows.map((row) => [row.key, row.label]));

function keysOf(permission: Record<string, readonly string[] | undefined>) {
  return Object.entries(permission)
    .filter(([resource]) => !INTERNAL_RESOURCES.has(resource))
    .flatMap(([resource, actions]) =>
      (actions ?? []).map((action) => `${resource}:${action}`),
    );
}

describe("permission labels", () => {
  // Wherever a role's permissions are listed, a key without a label shows as
  // the raw `resource:action`. A new resource has to join `resourceCategories`
  // to get one, which this catches.
  it("names every grantable permission in words", () => {
    const unlabeled = keysOf(allAvailableActions).filter(
      (key) => !labels.has(key),
    );
    expect(unlabeled).toEqual([]);
  });

  it("names every permission a built-in role grants", () => {
    const granted = [
      ...Object.values(predefinedPermissionsMap).flatMap(keysOf),
      ...fixedRoleGroups.flatMap((group) =>
        group.roles.flatMap((role) => keysOf(role.permission)),
      ),
    ];
    expect(granted.filter((key) => !labels.has(key))).toEqual([]);
  });

  it("never falls back to the key as the label", () => {
    const raw = allPermissionRows.filter(
      (row) => row.label.includes(":") || /undefined/.test(row.label),
    );
    expect(raw).toEqual([]);
  });
});
