import { FileModel } from "@/models";
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
