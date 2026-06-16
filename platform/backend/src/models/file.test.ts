import { FileModel, ProjectModel } from "@/models";
import { expect, test } from "@/test";

test("listForUser returns the user's own files and excludes project files", async ({
  makeUser,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: user.id,
    name: "proj",
    description: null,
  });

  const own = await FileModel.create({
    organizationId: org.id,
    userId: user.id,
    projectId: null,
    conversationId: null,
    filename: "mine.txt",
    mimeType: "text/plain",
    sizeBytes: 2,
    data: Buffer.from("hi"),
  });
  await FileModel.create({
    organizationId: org.id,
    userId: user.id,
    projectId: project.id,
    conversationId: null,
    filename: "proj.txt",
    mimeType: "text/plain",
    sizeBytes: 2,
    data: Buffer.from("hi"),
  });

  const mine = await FileModel.listForUser({
    organizationId: org.id,
    userId: user.id,
  });
  expect(mine.map((r) => r.id)).toEqual([own.id]);

  const projFiles = await FileModel.listByProject({
    organizationId: org.id,
    projectId: project.id,
  });
  expect(projFiles.map((r) => r.filename)).toEqual(["proj.txt"]);
});
