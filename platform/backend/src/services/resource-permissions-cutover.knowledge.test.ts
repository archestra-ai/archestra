// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

const READER_ROLES = ["admin", "editor", "member", "platform_admin"];

const readerGrants = READER_ROLES.map((id) => ({
  subject: { type: "role", id },
  actions: ["read", "use"],
}));

describe("knowledge sharing conversion", () => {
  test("an organization knowledge base converts to the reader roles and a private one to nobody", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const creator = await makeUser();
    await makeMember(creator.id, org.id);
    const published = await makeKnowledgeBase(org.id, {
      visibility: "org-wide",
    });
    const priv = await makeKnowledgeBase(org.id, {
      visibility: "private",
      createdBy: creator.id,
    });

    await runScopedResourcePermissionCutover();

    const read = async (scope: string) =>
      await ResourcePermissionPolicyModel.find({
        organizationId: org.id,
        resource: "knowledgeBase",
        scope,
      });
    expect((await read(published.id))?.grants).toEqual(readerGrants);
    // The candidate query hands knowledge objects a NULL author column by
    // design, so a private base converts to a policy only an administrator
    // reaches through the wildcard — its creator is deliberately not imported.
    expect(await read(priv.id)).toMatchObject({
      grants: [],
      legacySharingMigrated: true,
    });
  });

  test("a connector that is neither team-scoped nor unset converts to the organization audience", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const base = await makeKnowledgeBase(org.id);
    // Per-document ACLs synced from upstream: no static grant can express
    // them, so the conversion's CASE falls through to the organization branch.
    const connector = await makeKnowledgeBaseConnector(base.id, org.id, {
      visibility: "auto-sync-permissions",
    });

    await runScopedResourcePermissionCutover();

    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: org.id,
          resource: "knowledgeConnector",
          scope: connector.id,
        })
      )?.grants,
    ).toEqual(readerGrants);
  });

  test("uploaded files convert their uploader and their team rows", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const uploader = await makeUser();
    await makeMember(uploader.id, org.id);
    const team = await makeTeam(org.id, uploader.id);
    const published = await seedFile(org.id, uploader.id, "org-wide");
    const shared = await seedFile(org.id, uploader.id, "team-scoped");
    const priv = await seedFile(org.id, uploader.id, "private");
    await db.insert(schema.kbFileTeamsTable).values({
      kbFileId: shared.id,
      teamId: team.id,
    });

    await runScopedResourcePermissionCutover();

    const read = async (scope: string) =>
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: org.id,
          resource: "knowledgeFile",
          scope,
        })
      )?.grants;
    expect(await read(published.id)).toEqual(readerGrants);
    // `uploaded_by` is the file's author column, and the author grant is gated
    // on personal visibility — so only the private file carries its uploader.
    expect(await read(shared.id)).toEqual([
      { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
    ]);
    expect(await read(priv.id)).toEqual([
      {
        subject: { type: "user", id: uploader.id },
        actions: ["delete", "manage-permissions", "read", "update", "use"],
      },
    ]);
  });

  test("one retired knowledgeSource admin flag fans out to all three knowledge namespaces", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const role = await makeCustomRole(org.id, {
      permission: { knowledgeSource: ["read", "update", "admin"] },
    });

    await runScopedResourcePermissionCutover();

    for (const resource of [
      "knowledgeBase",
      "knowledgeConnector",
      "knowledgeFile",
    ] as const) {
      const policy = await ResourcePermissionPolicyModel.find({
        organizationId: org.id,
        resource,
        scope: "*",
      });
      const granted = policy?.grants.find(
        (grant) => grant.subject.id === role.id,
      );
      // `use` follows read and `manage-permissions` follows update. The role
      // never held delete, but no preset holds manage-permissions without it,
      // so the grant deliberately widens to Full access.
      expect(granted?.actions).toEqual([
        "delete",
        "manage-permissions",
        "read",
        "update",
        "use",
      ]);
    }
  });
});

async function seedFile(
  organizationId: string,
  uploadedBy: string,
  visibility: "org-wide" | "team-scoped" | "private",
) {
  const [file] = await db
    .insert(schema.kbFilesTable)
    .values({
      organizationId,
      uploadedBy,
      visibility,
      filename: `${visibility}-${crypto.randomUUID().slice(0, 8)}.txt`,
      mimeType: "text/plain",
      sizeBytes: 3,
      contentHash: crypto.randomUUID(),
      data: Buffer.from("abc"),
    })
    .returning();
  return file;
}
