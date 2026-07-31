import {
  FileModel,
  ProjectModel,
  ProjectShareModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
} from "@/models";
import { projectService } from "@/services/project";
import { fileStore } from "@/skills-sandbox/file-store";
import { describe, expect, test } from "@/test";

describe("projectService.delete (files retained + hidden)", () => {
  test("deleting a project retains its file rows and bytes but hides them", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "doomed",
      description: null,
    });
    const file = await fileStore.put({
      organizationId,
      userId: owner.id,
      projectId: project.id,
      conversationId: null,
      filename: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("abc"),
    });

    // sanity: the file is readable through the project before deletion
    expect(
      await fileStore.get({
        ref: file.id,
        organizationId,
        userId: owner.id,
      }),
    ).not.toBeNull();

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });

    // the file ROW is RETAINED (recoverable on restore) — soft-deleting the
    // project stops the FK cascade, and nothing purges the bytes anymore.
    expect(await FileModel.findById(file.id)).not.toBeNull();

    // ...but it is HIDDEN: every file access resolves the project first, and the
    // project is now soft-deleted, so the read returns null.
    expect(
      await fileStore.get({
        ref: file.id,
        organizationId,
        userId: owner.id,
      }),
    ).toBeNull();

    // the project itself is gone from the API...
    expect(await ProjectModel.findById(project.id)).toBeNull();
    await expect(
      projectService.get({ id: project.id, organizationId, userId: owner.id }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // ...but the row is retained (soft-deleted), so it can be restored.
    const { default: db, schema } = await import("@/database");
    const { eq } = await import("drizzle-orm");
    const [raw] = await db
      .select()
      .from(schema.projectsTable)
      .where(eq(schema.projectsTable.id, project.id));
    expect(raw.deletedAt).not.toBeNull();
  });
});

describe("projectService.delete (schedules retained + paused)", () => {
  test("deleting a project retains its scheduled tasks and runs but pauses them", async ({
    makeOrganization,
    makeUser,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "doomed",
      description: null,
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      projectId: project.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    // Five minutes ahead: an every-minute trigger is comfortably due by then.
    const soon = new Date(Date.now() + 5 * 60_000);

    // sanity: the trigger is due (would fire) while the project is live
    expect(
      (await ScheduleTriggerModel.findDueTriggers(soon)).map((t) => t.id),
    ).toContain(trigger.id);

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });

    // the trigger and its run are RETAINED (recoverable on restore), NOT deleted:
    // soft-deleting the project stops the FK cascade and nothing removes them.
    expect(await ScheduleTriggerModel.findById(trigger.id)).not.toBeNull();
    expect(await ScheduleTriggerRunModel.findById(run.id)).not.toBeNull();

    // ...but the trigger is PAUSED: a soft-deleted project's triggers never come
    // due, so the scheduler skips them (belongsToLiveProject, in SQL).
    expect(
      (await ScheduleTriggerModel.findDueTriggers(soon)).map((t) => t.id),
    ).not.toContain(trigger.id);
  });
});

describe("projectService.delete (org-wide share gate)", () => {
  test("an owner whose role lacks project:share-org cannot delete an org-wide project", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "create", "update", "delete"] },
    });
    await makeMember(owner.id, organizationId, { role: role.role });

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

    await expect(
      projectService.delete({
        id: project.id,
        organizationId,
        userId: owner.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("organization-wide"),
    });
    expect(await ProjectModel.findById(project.id)).not.toBeNull();
  });

  test("an owner with the default member role can delete their own org-wide project", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    await makeMember(owner.id, organizationId);

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "org-wide-deletable",
      description: null,
    });
    await projectService.setShare({
      id: project.id,
      organizationId,
      userId: owner.id,
      visibility: "organization",
      teamIds: [],
    });

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });
    expect(await ProjectModel.findById(project.id)).toBeNull();
  });
});
