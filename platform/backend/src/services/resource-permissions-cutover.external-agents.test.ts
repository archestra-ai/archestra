// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

const FULL_ACCESS = ["delete", "manage-permissions", "read", "update", "use"];
const READER_ROLES = ["admin", "editor", "member", "platform_admin"];

describe("external agent sharing conversion", () => {
  test("each external agent audience converts to the reach it had", async ({
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
    const personal = await seedExternalAgent(org.id, owner.id, "personal");
    const sharedWithPeople = await seedExternalAgent(
      org.id,
      owner.id,
      "personal",
    );
    const sharedWithTeam = await seedExternalAgent(org.id, owner.id, "team");
    const published = await seedExternalAgent(org.id, owner.id, "org");
    await db
      .insert(schema.a2aRemoteAgentUsersTable)
      .values({ remoteAgentId: sharedWithPeople.id, userId: reader.id });
    await db
      .insert(schema.a2aRemoteAgentTeamsTable)
      .values({ remoteAgentId: sharedWithTeam.id, teamId: team.id });

    await runScopedResourcePermissionCutover();

    const read = async (scope: string) =>
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: org.id,
          resource: "externalAgent",
          scope,
        })
      )?.grants;
    expect(await read(personal.id)).toEqual([
      { subject: { type: "user", id: owner.id }, actions: FULL_ACCESS },
    ]);
    const peopleGrants = await read(sharedWithPeople.id);
    expect(peopleGrants).toHaveLength(2);
    expect(peopleGrants).toEqual(
      expect.arrayContaining([
        { subject: { type: "user", id: owner.id }, actions: FULL_ACCESS },
        { subject: { type: "user", id: reader.id }, actions: ["read", "use"] },
      ]),
    );
    expect(await read(sharedWithTeam.id)).toEqual([
      { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
    ]);
    // Seeing an external agent took the `agent` read action, so the
    // organization audience becomes the roles holding it.
    expect(await read(published.id)).toEqual(
      READER_ROLES.map((id) => ({
        subject: { type: "role", id },
        actions: ["read", "use"],
      })),
    );
  });

  test("whoever reaches every local agent reaches every external agent", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const agentAdmin = await makeCustomRole(org.id, {
      // `admin` is the retired role action that reached every local agent.
      permission: { agent: ["read", "admin"] } as never,
    });
    const settingsManager = await makeCustomRole(org.id, {
      permission: { agent: ["read"], organizationSettings: ["update"] },
    });

    await runScopedResourcePermissionCutover();

    const grantsAt = async (resource: "agent" | "externalAgent") =>
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: org.id,
          resource,
          scope: "*",
        })
      )?.grants ?? [];
    const external = await grantsAt("externalAgent");
    for (const grant of await grantsAt("agent")) {
      expect(external).toContainEqual(grant);
    }
    // Same reach on both: here, read and use on every agent.
    const local = (await grantsAt("agent")).find(
      (grant) => grant.subject.id === agentAdmin.id,
    );
    expect(local?.actions).toEqual(["read", "use"]);
    expect(external).toContainEqual(local);
    // Organization settings are not an agent permission.
    expect(
      external.some((grant) => grant.subject.id === settingsManager.id),
    ).toBe(false);
    for (const id of ["admin", "platform_admin"]) {
      expect(external).toContainEqual({
        subject: { type: "role", id },
        actions: FULL_ACCESS,
      });
    }
  });
});

async function seedExternalAgent(
  organizationId: string,
  authorId: string,
  scope: "personal" | "team" | "org",
) {
  const [remoteAgent] = await db
    .insert(schema.a2aRemoteAgentsTable)
    .values({
      organizationId,
      authorId,
      scope,
      name: `External ${scope} ${crypto.randomUUID().slice(0, 8)}`,
      discoveryMode: "inline_card",
      agentCard: { name: `External ${scope}` },
      cardHash: crypto.randomUUID(),
    })
    .returning();
  return remoteAgent;
}
