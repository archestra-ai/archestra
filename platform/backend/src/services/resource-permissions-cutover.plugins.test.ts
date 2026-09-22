// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

const READER_ROLES = ["admin", "editor", "member", "platform_admin"];

describe("plugin sharing conversion", () => {
  test("each plugin scope converts to the audience it had", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const reader = await makeUser();
    for (const user of [owner, reader]) await makeMember(user.id, org.id);
    const team = await makeTeam(org.id, owner.id);
    const personal = await seedPlugin(org.id, owner.id, "personal");
    const shared = await seedPlugin(org.id, owner.id, "team");
    const published = await seedPlugin(org.id, owner.id, "org");
    await db
      .insert(schema.pluginTeamsTable)
      .values({ pluginId: shared.id, teamId: team.id });
    await db
      .insert(schema.pluginUsersTable)
      .values({ pluginId: personal.id, userId: reader.id });

    await runScopedResourcePermissionCutover();

    const read = async (scope: string) =>
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: org.id,
          resource: "plugin",
          scope,
        })
      )?.grants;
    // Ordered by subject id, which is a random UUID here, so the pair is
    // matched as a set of exactly two grants.
    const personalGrants = await read(personal.id);
    expect(personalGrants).toHaveLength(2);
    expect(personalGrants).toEqual(
      expect.arrayContaining([
        {
          subject: { type: "user", id: owner.id },
          actions: ["delete", "manage-permissions", "read", "update", "use"],
        },
        { subject: { type: "user", id: reader.id }, actions: ["read", "use"] },
      ]),
    );
    expect(await read(shared.id)).toEqual([
      { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
    ]);
    // A plugin has no "work with it" path of its own, so organization-wide
    // visibility converts to the reader roles alone — no `organization:*` use
    // grant, unlike an agent, a gateway or a model.
    expect(await read(published.id)).toEqual(
      READER_ROLES.map((id) => ({
        subject: { type: "role", id },
        actions: ["read", "use"],
      })),
    );
  });

  test("a custom plugin admin role converts to the CRUD it actually held and loses the flag", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const role = await makeCustomRole(org.id, {
      permission: { plugin: ["read", "admin"] },
    });

    await runScopedResourcePermissionCutover();

    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "plugin",
      scope: "*",
    });
    // The old flag widened reach; it never manufactured actions. A read-only
    // plugin administrator comes out read-only.
    expect(
      policy?.grants.find((grant) => grant.subject.id === role.id),
    ).toEqual({
      subject: { type: "role", id: role.id },
      actions: ["read", "use"],
    });
    expect(policy?.grants).toEqual(
      expect.arrayContaining(
        ["admin", "platform_admin"].map((id) => ({
          subject: { type: "role", id },
          actions: ["delete", "manage-permissions", "read", "update", "use"],
        })),
      ),
    );
    expect(policy?.grants).toHaveLength(3);
    const [row] = await db
      .select({ permission: schema.organizationRolesTable.permission })
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, role.id));
    expect(JSON.parse(row.permission).plugin).toEqual(["read"]);
  });
});

async function seedPlugin(
  organizationId: string,
  authorId: string,
  scope: "personal" | "team" | "org",
) {
  const [plugin] = await db
    .insert(schema.pluginsTable)
    .values({
      organizationId,
      authorId,
      scope,
      clientType: "claude-code",
      pluginSlug: `plugin-${crypto.randomUUID().slice(0, 8)}`,
      displayName: `Plugin ${scope}`,
      contentHash: crypto.randomUUID(),
    })
    .returning();
  return plugin;
}
