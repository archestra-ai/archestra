import { ConversationModel, FileModel, ProjectModel } from "@/models";
import { FileNameExistsError } from "@/models/file";
import { expect, test } from "@/test";

/** Insert a db-backed row directly (orchestration is FileStore's job). */
function insert(params: {
  organizationId: string;
  userId: string;
  projectId?: string | null;
  conversationId?: string | null;
  filename: string;
}) {
  return FileModel.insertRow({
    organizationId: params.organizationId,
    userId: params.userId,
    projectId: params.projectId ?? null,
    conversationId: params.conversationId ?? null,
    filename: params.filename,
    mimeType: "text/plain",
    sizeBytes: 2,
    storageProvider: "db",
    data: Buffer.from("hi"),
    objectKey: null,
  });
}

test("listNoProjectByConversation returns the user's no-project files in that conversation only", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const convA = await ConversationModel.create({
    userId: user.id,
    organizationId: org.id,
    agentId: agent.id,
  });
  const convB = await ConversationModel.create({
    userId: user.id,
    organizationId: org.id,
    agentId: agent.id,
  });
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: user.id,
    name: "proj",
    description: null,
  });

  const inA = await insert({
    organizationId: org.id,
    userId: user.id,
    conversationId: convA.id,
    filename: "mine.txt",
  });
  // another conversation's file and a project file must both be excluded
  await insert({
    organizationId: org.id,
    userId: user.id,
    conversationId: convB.id,
    filename: "other.txt",
  });
  await insert({
    organizationId: org.id,
    userId: user.id,
    conversationId: convA.id,
    projectId: project.id,
    filename: "proj.txt",
  });

  const inConvA = await FileModel.listNoProjectByConversation({
    organizationId: org.id,
    userId: user.id,
    conversationId: convA.id,
  });
  expect(inConvA.map((r) => r.id)).toEqual([inA.id]);

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

  const mine = await insert({
    organizationId: org.id,
    userId: me.id,
    conversationId: conv.id,
    filename: "mine.txt",
  });
  await insert({
    organizationId: org.id,
    userId: other.id,
    conversationId: conv.id,
    filename: "theirs.txt",
  });

  const listed = await FileModel.listByConversation({
    organizationId: org.id,
    userId: me.id,
    conversationId: conv.id,
  });
  expect(listed.map((r) => r.filename)).toEqual(["mine.txt"]);
  expect(listed[0].id).toBe(mine.id);
});

test("insertRow rejects a duplicate filename in the same conversation", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await ConversationModel.create({
    userId: user.id,
    organizationId: org.id,
    agentId: agent.id,
  });
  await insert({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    filename: "dup.txt",
  });
  await expect(
    insert({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
      filename: "dup.txt",
    }),
  ).rejects.toBeInstanceOf(FileNameExistsError);
});

test("insertRow allows the same filename in two different conversations", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const convA = await ConversationModel.create({
    userId: user.id,
    organizationId: org.id,
    agentId: agent.id,
  });
  const convB = await ConversationModel.create({
    userId: user.id,
    organizationId: org.id,
    agentId: agent.id,
  });
  await insert({
    organizationId: org.id,
    userId: user.id,
    conversationId: convA.id,
    filename: "report.txt",
  });
  await expect(
    insert({
      organizationId: org.id,
      userId: user.id,
      conversationId: convB.id,
      filename: "report.txt",
    }),
  ).resolves.toBeTruthy();
});

test("insertRow rejects a duplicate filename for a user's headless (no-conversation) files", async ({
  makeUser,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  // conversationId omitted → null: the orphan index keeps these unique per user.
  await insert({
    organizationId: org.id,
    userId: user.id,
    filename: "dup.txt",
  });
  await expect(
    insert({ organizationId: org.id, userId: user.id, filename: "dup.txt" }),
  ).rejects.toBeInstanceOf(FileNameExistsError);
});
