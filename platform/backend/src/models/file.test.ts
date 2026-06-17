import { ConversationModel, FileModel, ProjectModel } from "@/models";
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

test("listByConversation returns only the caller's files in that conversation", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const me = await makeUser();
  const other = await makeUser({ email: "other-author@test.com" });
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await ConversationModel.create({
    userId: me.id,
    organizationId: org.id,
    agentId: agent.id,
  });

  const mine = await FileModel.create({
    organizationId: org.id,
    userId: me.id,
    projectId: null,
    conversationId: conv.id,
    filename: "mine.txt",
    mimeType: "text/plain",
    sizeBytes: 2,
    data: Buffer.from("hi"),
  });
  await FileModel.create({
    organizationId: org.id,
    userId: other.id,
    projectId: null,
    conversationId: conv.id,
    filename: "theirs.txt",
    mimeType: "text/plain",
    sizeBytes: 2,
    data: Buffer.from("hi"),
  });

  const listed = await FileModel.listByConversation({
    organizationId: org.id,
    userId: me.id,
    conversationId: conv.id,
  });
  expect(listed.map((r) => r.filename)).toEqual(["mine.txt"]);
  expect(listed[0].id).toBe(mine.id);
});
