// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

test("retired team-relative policies preserve current authority as individual object grants", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeAgent,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const owner = await makeUser();
  const editor = await makeUser();
  await makeMember(owner.id, org.id);
  await makeMember(editor.id, org.id, { role: "editor" });
  const team = await makeTeam(org.id, owner.id);
  await makeTeamMember(team.id, editor.id);
  const shared = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: { teams: [team.id] },
  });
  const explicit = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "personal",
  });
  const unrelated = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "personal",
  });
  await runScopedResourcePermissionCutover();
  const key = { organizationId: org.id, resource: "agent" as const };
  const direct = await ResourcePermissionPolicyModel.replace({
    ...key,
    scope: explicit.id,
    revision:
      (await ResourcePermissionPolicyModel.find({ ...key, scope: explicit.id }))
        ?.revision ?? 0,
    grants: [
      {
        subject: { type: "team", id: team.id },
        actions: ["read", "use", "update"],
      },
    ],
  });
  const wildcard = await ResourcePermissionPolicyModel.replace({
    ...key,
    scope: "*",
    revision:
      (await ResourcePermissionPolicyModel.find({ ...key, scope: "*" }))
        ?.revision ?? 0,
    grants: [{ subject: { type: "user", id: owner.id }, actions: ["read"] }],
  });
  // Seed the obsolete persisted shape directly: the current API rejects it.
  await db.insert(schema.resourcePermissionPoliciesTable).values({
    ...key,
    scope: "teams:*",
    legacySharingMigrated: true,
    grants: [
      {
        subject: { type: "role", id: "editor" },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ],
  });

  await expect(
    db.transaction(async (tx) => {
      await runScopedResourcePermissionCutover(tx);
      throw new Error("simulated cutover failure");
    }),
  ).rejects.toThrow("simulated cutover failure");
  expect(
    await db
      .select()
      .from(schema.resourcePermissionPoliciesTable)
      .where(eq(schema.resourcePermissionPoliciesTable.scope, "teams:*")),
  ).toHaveLength(1);

  let migratedDirect:
    | Awaited<ReturnType<typeof ResourcePermissionPolicyModel.find>>
    | undefined;
  for (let restart = 0; restart < 2; restart++) {
    await runScopedResourcePermissionCutover();
    const actualDirect = await ResourcePermissionPolicyModel.find({
      ...key,
      scope: explicit.id,
    });
    expect(
      actualDirect?.grants.find(
        (grant) =>
          grant.subject.type === "team" && grant.subject.id === team.id,
      )?.actions,
    ).toEqual(expect.arrayContaining(direct?.grants[0].actions ?? []));
    if (restart === 0) migratedDirect = actualDirect;
    else expect(actualDirect).toEqual(migratedDirect);
    expect(
      await ResourcePermissionPolicyModel.find({ ...key, scope: "*" }),
    ).toEqual(wildcard);
    expect(
      await db
        .select()
        .from(schema.resourcePermissionPoliciesTable)
        .where(eq(schema.resourcePermissionPoliciesTable.scope, "teams:*")),
    ).toEqual([]);
    const access = { ...key, userId: editor.id };
    expect(
      await ResourcePermissions.allows({
        ...access,
        scope: shared.id,
        action: "read",
      }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({
        ...access,
        scope: explicit.id,
        action: "update",
      }),
    ).toBe(true);
    for (const scope of [shared.id, unrelated.id]) {
      for (const action of [
        "update",
        "delete",
        "manage-permissions",
      ] as const) {
        expect(
          await ResourcePermissions.allows({ ...access, scope, action }),
        ).toBe(scope === shared.id);
      }
    }
  }
});

test("an explicitly empty migrated relative policy suppresses legacy Editor authority", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeAgent,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const owner = await makeUser();
  const editor = await makeUser();
  await makeMember(owner.id, org.id);
  await makeMember(editor.id, org.id, { role: "editor" });
  const team = await makeTeam(org.id, owner.id);
  await makeTeamMember(team.id, editor.id);
  const agent = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: { teams: [team.id] },
  });
  await db.insert(schema.resourcePermissionPoliciesTable).values({
    organizationId: org.id,
    resource: "agent",
    scope: "teams:*",
    legacySharingMigrated: true,
    grants: [],
  });
  for (let replay = 0; replay < 2; replay++) {
    await runScopedResourcePermissionCutover();
    const access = {
      organizationId: org.id,
      userId: editor.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    expect(
      await ResourcePermissions.allows({ ...access, action: "read" }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({ ...access, action: "update" }),
    ).toBe(false);
  }
});
