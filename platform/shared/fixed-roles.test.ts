// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test } from "vitest";
import { allAvailableActions } from "./access-control";
import { fixedRoles, getFixedRole } from "./fixed-roles";
import {
  type Action,
  internalResources,
  type Resource,
} from "./permission.types";
import { RoleAssignmentSchema } from "./roles";

describe("fixed role catalog", () => {
  test("every grantable action is reachable through some fixed role", () => {
    // A new action added to the permission map without a fixed role would
    // leave admins composing roles from fixed parts unable to grant it.
    const covered = new Set(
      fixedRoles.flatMap((entry) =>
        Object.entries(entry.permission).flatMap(([resource, actions]) =>
          (actions ?? []).map((action) => `${resource}:${action}`),
        ),
      ),
    );
    const missing = (Object.keys(allAvailableActions) as Resource[])
      .filter((resource) => !internalResources.includes(resource))
      .flatMap((resource) =>
        allAvailableActions[resource].map((action) => `${resource}:${action}`),
      )
      .filter((key) => !covered.has(key));
    expect(missing).toEqual([]);
  });

  test("no fixed role names an action outside the permission map", () => {
    // Actions outside the universe are dropped at resolution, so a typo here
    // would silently grant less than the role's name promises.
    const unknown = fixedRoles.flatMap((entry) =>
      Object.entries(entry.permission).flatMap(([resource, actions]) =>
        (actions ?? [])
          .filter(
            (action) =>
              !allAvailableActions[resource as Resource]?.includes(
                action as Action,
              ),
          )
          .map((action) => `${entry.role} → ${resource}:${action}`),
      ),
    );
    expect(unknown).toEqual([]);
  });

  test("a role that grants any action on a resource also lets the holder open it", () => {
    // Every other action on a resource assumes its page can be opened; a
    // writer without read would be a role that cannot reach what it writes.
    const withoutRead = fixedRoles.flatMap((entry) =>
      Object.entries(entry.permission)
        .filter(
          ([resource, actions]) =>
            allAvailableActions[resource as Resource].includes("read") &&
            !actions?.includes("read"),
        )
        .map(([resource]) => `${entry.role} → ${resource}`),
    );
    expect(withoutRead).toEqual([]);
  });

  test("identifiers are unique and assignable wherever a role is", () => {
    const identifiers = fixedRoles.map((entry) => entry.role);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    for (const identifier of identifiers) {
      expect(RoleAssignmentSchema.safeParse(identifier).success).toBe(true);
      expect(getFixedRole(identifier)?.role).toBe(identifier);
    }
    expect(
      RoleAssignmentSchema.safeParse(`member,${identifiers[0]}`).success,
    ).toBe(true);
  });
});
