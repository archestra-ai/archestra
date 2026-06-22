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

  const own = await insert({
    organizationId: org.id,
    userId: user.id,
    filename: "mine.txt",
  });
  await insert({
    organizationId: org.id,
    userId: user.id,
    projectId: project.id,
    filename: "proj.txt",
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

test("insertRow rejects a duplicate filename in the same owner scope", async ({
  makeUser,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await insert({
    organizationId: org.id,
    userId: user.id,
    filename: "dup.txt",
  });
  await expect(
    insert({ organizationId: org.id, userId: user.id, filename: "dup.txt" }),
  ).rejects.toBeInstanceOf(FileNameExistsError);
});
