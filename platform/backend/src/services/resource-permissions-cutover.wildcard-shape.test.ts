// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

const MANAGE = [
  "delete",
  "manage-permissions",
  "read",
  "update",
  "use",
] as const;

describe("wildcard policy shape", () => {
  test("an organization with nothing in it still converts the built-in role authority", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });

    await runScopedResourcePermissionCutover();

    const read = async (resource: "agent" | "mcpGateway" | "mcpRegistry") =>
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: org.id,
          resource,
          scope: "*",
        })
      )?.grants;
    const adminTiers = ["admin", "platform_admin"].map((id) => ({
      subject: { type: "role", id },
      actions: [...MANAGE],
    }));
    for (const resource of [
      "agent",
      "mcpGateway",
      "mcpRegistry",
      "skill",
      "app",
    ] as const)
      expect(
        await read(resource as "agent" | "mcpGateway" | "mcpRegistry"),
      ).toEqual(adminTiers);
    // The model catalog is the one resource where Editor held wildcard
    // authority of its own. It never included delete, but no preset holds
    // manage-permissions without delete, so the grant widens to Full access.
    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: org.id,
          resource: "llmModel",
          scope: "*",
        })
      )?.grants,
    ).toEqual([
      { subject: { type: "role", id: "admin" }, actions: [...MANAGE] },
      { subject: { type: "role", id: "editor" }, actions: [...MANAGE] },
      { subject: { type: "role", id: "platform_admin" }, actions: [...MANAGE] },
    ]);
  });

  /**
   * `use` follows read and `manage-permissions` follows update. The retired
   * `admin` flag widened a role's reach to objects it did not own; it never
   * manufactured a CRUD action the role did not already hold.
   *
   * Every stored grant is then one preset, so a converted set that sits
   * between two presets widens to the larger one. That is a deliberate
   * escalation: an update-only or delete-only administrator becomes Full
   * access. The middle column is the set before that last widening.
   */
  for (const [held, , expected] of [
    [["read"], ["read", "use"], ["read", "use"]],
    [["update"], ["manage-permissions", "update"], MANAGE],
    [["delete"], ["delete"], MANAGE],
    [
      ["read", "update"],
      ["manage-permissions", "read", "update", "use"],
      MANAGE,
    ],
    [["read", "delete"], ["delete", "read", "use"], MANAGE],
    [["update", "delete"], ["delete", "manage-permissions", "update"], MANAGE],
    [
      ["read", "update", "delete"],
      ["delete", "manage-permissions", "read", "update", "use"],
      MANAGE,
    ],
  ] as const) {
    test(`a custom agent administrator holding ${held.join("+")} converts to ${expected.join("+")}`, async ({
      makeOrganization,
      makeCustomRole,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const role = await makeCustomRole(org.id, {
        permission: { agent: [...held, "admin"] },
      });

      await runScopedResourcePermissionCutover();

      const policy = await ResourcePermissionPolicyModel.find({
        organizationId: org.id,
        resource: "agent",
        scope: "*",
      });
      expect(
        policy?.grants.find((grant) => grant.subject.id === role.id)?.actions,
      ).toEqual([...expected]);
    });
  }

  test("log authority converts asymmetrically: only the built-in admin may delegate it", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const role = await makeCustomRole(org.id, {
      permission: { log: ["read", "admin"], auditLog: ["read", "admin"] },
    });

    await runScopedResourcePermissionCutover();

    for (const resource of ["log", "auditLog"] as const) {
      const grants =
        (
          await ResourcePermissionPolicyModel.find({
            organizationId: org.id,
            resource,
            scope: "*",
          })
        )?.grants ?? [];
      // Logs are read-only for everyone, and `platform_admin` never held the
      // two log actions at all, so it gets no grant here.
      expect(grants).toHaveLength(2);
      expect(grants).toEqual(
        expect.arrayContaining([
          {
            subject: { type: "role", id: "admin" },
            actions: ["manage-permissions", "read"],
          },
          { subject: { type: "role", id: role.id }, actions: ["read"] },
        ]),
      );
      expect(
        grants.some((grant) => grant.subject.id === "platform_admin"),
      ).toBe(false);
    }
  });
});
