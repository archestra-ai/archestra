import {
  ProjectModel,
  ProjectShareModel,
  ScheduleTriggerModel,
} from "@/models";
import { projectService } from "@/services/project";
import { fileStore } from "@/skills-sandbox/file-store";
import { describe, expect, test } from "@/test";

describe("projectService.restore (admin oversight)", () => {
  test("a project admin restores a soft-deleted project, un-hiding its retained files", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "delete", "admin"] },
    });
    const admin = await makeUser({ email: "restore-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: role.role });

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "recoverable",
      description: null,
    });
    const file = await fileStore.put({
      organizationId,
      userId: owner.id,
      projectId: project.id,
      conversationId: null,
      filename: "keep.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("abc"),
    });

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });
    // hidden while deleted
    expect(
      await fileStore.get({ ref: file.id, organizationId, userId: owner.id }),
    ).toBeNull();

    const restored = await projectService.restore({
      id: project.id,
      organizationId,
      userId: admin.id,
    });
    expect(restored.id).toBe(project.id);
    // active again from the API's point of view
    expect(await ProjectModel.findById(project.id)).not.toBeNull();
    // ...and its retained file is reachable once more
    expect(
      await fileStore.get({ ref: file.id, organizationId, userId: owner.id }),
    ).not.toBeNull();
  });

  test("restore resumes schedules FORWARD-ONLY — no catch-up fire for the deleted window", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
    makeScheduleTrigger,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "delete", "admin"] },
    });
    const admin = await makeUser({ email: "restore-sched-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: role.role });

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "scheduled",
      description: null,
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      projectId: project.id,
    });
    // A baseline well in the past makes an every-minute trigger overdue: without
    // the forward-only bump, restore would fire it once to "catch up".
    await ScheduleTriggerModel.markExecuted(
      trigger.id,
      new Date(Date.now() - 10 * 60_000),
    );

    const isDue = async () =>
      (await ScheduleTriggerModel.findDueTriggers(new Date())).some(
        (t) => t.id === trigger.id,
      );

    // due while live, paused while deleted
    expect(await isDue()).toBe(true);
    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });
    expect(await isDue()).toBe(false);

    await projectService.restore({
      id: project.id,
      organizationId,
      userId: admin.id,
    });

    // live again, but its baseline was bumped to the restore instant, so its
    // next run is in the future — it does NOT fire immediately to backfill.
    expect(await isDue()).toBe(false);
    // the trigger itself is unchanged/retained (still enabled, still its cron).
    const after = await ScheduleTriggerModel.findById(trigger.id);
    expect(after?.enabled).toBe(true);
  });

  test("restore does NOT re-attach detached chats — the project comes back with zero conversations", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
    makeInternalAgent,
    makeConversation,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "delete", "admin"] },
    });
    const admin = await makeUser({ email: "restore-chat-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: role.role });

    const agent = await makeInternalAgent({ organizationId });
    const conversation = await makeConversation(agent.id, {
      userId: owner.id,
      organizationId,
    });
    const { project } = await projectService.createProjectFromConversation({
      organizationId,
      userId: owner.id,
      conversationId: conversation.id,
      name: "from-chat",
    });

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });
    const restored = await projectService.restore({
      id: project.id,
      organizationId,
      userId: admin.id,
    });

    // The chat detached on delete and is never re-adopted, so the restored
    // project reports no chats even though it had one before.
    expect(restored.conversationCount).toBe(0);
  });

  test("a caller without project:admin cannot restore (404)", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "owned",
      description: null,
    });
    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });

    // The owner can delete their own project but is not a project:admin, so the
    // admin-only restore reads as "not found".
    await expect(
      projectService.restore({
        id: project.id,
        organizationId,
        userId: owner.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("restoring an already-active project is a 404", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "delete", "admin"] },
    });
    const admin = await makeUser({ email: "restore-active-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: role.role });

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "still-here",
      description: null,
    });

    await expect(
      projectService.restore({
        id: project.id,
        organizationId,
        userId: admin.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("restore collides with a same-named project created while it was deleted (409)", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "delete", "admin"] },
    });
    const admin = await makeUser({ email: "restore-conflict-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: role.role });

    const first = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "dup",
      description: null,
    });
    // Deleting frees the display name (the unique index is partial on
    // deleted_at IS NULL)...
    await projectService.delete({
      id: first.id,
      organizationId,
      userId: owner.id,
    });
    // ...so the owner can take it again with a fresh project.
    await projectService.create({
      organizationId,
      userId: owner.id,
      name: "dup",
      description: null,
    });

    // Restoring the first would re-enter (owner, "dup") into the partial index,
    // which now collides — surfaced as a 409, mapped inside the restore tx.
    await expect(
      projectService.restore({
        id: first.id,
        organizationId,
        userId: admin.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("`name` restores past that collision, renaming without disturbing the project that took the name", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "delete", "admin"] },
    });
    const admin = await makeUser({ email: "restore-rename-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: role.role });

    const first = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "dup",
      description: null,
    });
    const originalSlug = (await ProjectModel.findById(first.id))?.slug;
    await projectService.delete({
      id: first.id,
      organizationId,
      userId: owner.id,
    });
    const squatter = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "dup",
      description: null,
    });

    const restored = await projectService.restore({
      id: first.id,
      organizationId,
      userId: admin.id,
      name: "dup (recovered)",
    });

    expect(restored.id).toBe(first.id);
    expect(restored.name).toBe("dup (recovered)");
    // The rename is a display-name change only: a restore must still land on
    // the project's own folder, so the slug is untouched (as ordinary renames
    // leave it).
    expect((await ProjectModel.findById(first.id))?.slug).toBe(originalSlug);
    // ...and the project that took the name keeps it.
    expect((await ProjectModel.findById(squatter.id))?.name).toBe("dup");
  });

  test("a rename into a name that is ALSO taken is still a 409, and leaves the project deleted", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "delete", "admin"] },
    });
    const admin = await makeUser({ email: "restore-rename-taken@test.com" });
    await makeMember(admin.id, organizationId, { role: role.role });

    const first = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "dup",
      description: null,
    });
    await projectService.delete({
      id: first.id,
      organizationId,
      userId: owner.id,
    });
    await projectService.create({
      organizationId,
      userId: owner.id,
      name: "dup",
      description: null,
    });
    await projectService.create({
      organizationId,
      userId: owner.id,
      name: "also taken",
      description: null,
    });

    await expect(
      projectService.restore({
        id: first.id,
        organizationId,
        userId: admin.id,
        name: "also taken",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // The rename and the un-delete share a transaction, so a rejected restore
    // rolls the rename back rather than leaving a renamed, still-deleted row.
    expect(await ProjectModel.findById(first.id)).toBeNull();
    const stillDeleted = await ProjectModel.findDeletedByIdForOrganization({
      id: first.id,
      organizationId,
    });
    expect(stillDeleted?.name).toBe("dup");
  });

  test("an admin without project:share-org cannot restore an org-wide project (403)", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "delete", "admin"] },
    });
    const admin = await makeUser({ email: "restore-share-org@test.com" });
    await makeMember(admin.id, organizationId, { role: role.role });
    // The default member role carries project:share-org, so the owner can take
    // their own org-wide project down; the restore is what must be gated.
    await makeMember(owner.id, organizationId);

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "org-wide",
      description: null,
    });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });

    // Restore is gated exactly as delete is: putting an org-wide project back
    // in front of the whole org needs the same permission taking it away did.
    await expect(
      projectService.restore({
        id: project.id,
        organizationId,
        userId: admin.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("organization-wide"),
    });
    expect(await ProjectModel.findById(project.id)).toBeNull();
  });

  test("a project admin cannot restore another organization's deleted project (404)", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const victimOrgId = (await makeOrganization()).id;
    const victimOwner = await makeUser({
      email: "cross-tenant-owner@test.com",
    });
    const project = await projectService.create({
      organizationId: victimOrgId,
      userId: victimOwner.id,
      name: "not yours",
      description: null,
    });
    await projectService.delete({
      id: project.id,
      organizationId: victimOrgId,
      userId: victimOwner.id,
    });

    // A full project admin — but of a DIFFERENT org.
    const attackerOrgId = (await makeOrganization()).id;
    const role = await makeCustomRole(attackerOrgId, {
      permission: { project: ["read", "delete", "admin"] },
    });
    const attacker = await makeUser({ email: "cross-tenant-admin@test.com" });
    await makeMember(attacker.id, attackerOrgId, { role: role.role });

    await expect(
      projectService.restore({
        id: project.id,
        organizationId: attackerOrgId,
        userId: attacker.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Still deleted in its own org — the lookup is org-scoped, so the id alone
    // reaches nothing.
    expect(
      await ProjectModel.findDeletedByIdForOrganization({
        id: project.id,
        organizationId: victimOrgId,
      }),
    ).not.toBeNull();
  });
});
