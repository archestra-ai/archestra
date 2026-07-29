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

describe("projectService.delete (file cascade)", () => {
  test("deleting a project deletes its files", async ({
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

    // sanity: the file is owned by the project before deletion
    expect(await FileModel.findById(file.id)).not.toBeNull();
    expect(
      await FileModel.listByProject({ organizationId, projectId: project.id }),
    ).toHaveLength(1);

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });

    // the FK cascade takes the project's files with it
    expect(await FileModel.findById(file.id)).toBeNull();
    expect(
      await FileModel.listByProject({ organizationId, projectId: project.id }),
    ).toEqual([]);
  });
});

describe("projectService.delete (schedule cascade)", () => {
  test("deleting a project deletes its scheduled tasks and their runs", async ({
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

    // sanity: the scheduled task and its run belong to the project beforehand
    expect(await ScheduleTriggerModel.findById(trigger.id)).not.toBeNull();
    expect(await ScheduleTriggerRunModel.findById(run.id)).not.toBeNull();

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });

    // the FK cascade takes the project's scheduled tasks (and their runs) with
    // it, rather than leaving them orphaned with a null project_id where they
    // keep firing but no longer surface in any project.
    expect(await ScheduleTriggerModel.findById(trigger.id)).toBeNull();
    expect(await ScheduleTriggerRunModel.findById(run.id)).toBeNull();
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
