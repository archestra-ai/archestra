import { eq } from "drizzle-orm";
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

/**
 * Credentials are the two resources whose recipients are not a junction table
 * apiece: a virtual key keeps a junction, a provider key keeps two columns on
 * its own row. Both convert here, and neither had a test before.
 */
describe("credential sharing conversion", () => {
  test("a team-scoped virtual key converts only the teams of its own organization", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeVirtualApiKey,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const foreign = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const outsider = await makeUser();
    await makeMember(owner.id, org.id);
    await makeMember(outsider.id, foreign.id);
    const local = await makeTeam(org.id, owner.id);
    const elsewhere = await makeTeam(foreign.id, outsider.id);
    const key = await makeVirtualApiKey(org.id, {
      access: "personal",
      authorId: owner.id,
    });
    // The cutover converts the retired sharing columns, so the seed writes
    // them directly: create no longer does.
    await db
      .update(schema.virtualApiKeysTable)
      .set({ scope: "team" })
      .where(eq(schema.virtualApiKeysTable.id, key.id));
    await db.insert(schema.virtualApiKeyTeamsTable).values([
      { virtualApiKeyId: key.id, teamId: local.id },
      { virtualApiKeyId: key.id, teamId: elsewhere.id },
    ]);
    await removeObjectPolicies(org.id);

    await runScopedResourcePermissionCutover();

    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "llmVirtualKey",
      scope: key.id,
    });
    expect(policy?.legacySharingMigrated).toBe(true);
    // The foreign team is dropped by the organization join, and a team-scoped
    // key gives its author nothing beyond what the team already carries.
    expect(policy?.grants).toEqual([
      { subject: { type: "team", id: local.id }, actions: ["read", "use"] },
    ]);
  });

  test("provider keys convert their team column and their personal author separately", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeSecret,
    makeLlmProviderApiKey,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    await makeMember(owner.id, org.id);
    const team = await makeTeam(org.id, owner.id);
    const secret = await makeSecret();
    const shared = await makeLlmProviderApiKey(org.id, secret.id);
    // The cutover converts the retired team column, so the seed writes it
    // directly: create no longer does.
    await db
      .update(schema.llmProviderApiKeysTable)
      .set({ scope: "team", teamId: team.id })
      .where(eq(schema.llmProviderApiKeysTable.id, shared.id));
    const personal = await makeLlmProviderApiKey(org.id, secret.id, {
      userId: owner.id,
    });
    await removeObjectPolicies(org.id);

    await runScopedResourcePermissionCutover();

    const read = (scope: string) =>
      ResourcePermissionPolicyModel.find({
        organizationId: org.id,
        resource: "llmProviderApiKey",
        scope,
      });
    expect((await read(shared.id))?.grants).toEqual([
      { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
    ]);
    // `user_id` is the audience of a personal key, so it converts to the owner
    // grant that lets that one person keep managing their own credential.
    expect((await read(personal.id))?.grants).toEqual([
      {
        subject: { type: "user", id: owner.id },
        actions: ["delete", "manage-permissions", "read", "update", "use"],
      },
    ]);
  });

  test("a personal provider key whose owner left the organization converts to an authoritative empty policy", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    // Never a member: the author grant joins `member`, so nothing survives.
    const stranger = await makeUser();
    const secret = await makeSecret();
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      userId: stranger.id,
    });
    await removeObjectPolicies(org.id);

    await runScopedResourcePermissionCutover();

    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "llmProviderApiKey",
      scope: key.id,
    });
    // Empty but migrated: the key is reachable through the wildcard policy
    // only, and a restart cannot resurrect the departed owner's access.
    expect(policy).toMatchObject({ grants: [], legacySharingMigrated: true });
  });
});
