import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import ConversationModel from "@/models/conversation";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import ConversationShareModel from "@/models/conversation-share";
import FileModel from "@/models/file";
import ProjectModel from "@/models/project";
import { projectService } from "@/services/project";
import { fileStore } from "@/skills-sandbox/file-store";
import { expect, test } from "@/test";
import { ApiError } from "@/types";

async function putFile(params: {
  organizationId: string;
  userId: string;
  conversationId: string;
  filename: string;
  projectId?: string | null;
}) {
  return fileStore.put({
    organizationId: params.organizationId,
    userId: params.userId,
    projectId: params.projectId ?? null,
    conversationId: params.conversationId,
    filename: params.filename,
    mimeType: "text/plain",
    sizeBytes: 3,
    data: Buffer.from("abc"),
  });
}

test("creates a project, moves the chat into it, and re-points its files", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
    title: "Quarterly research",
  });
  const a = await putFile({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    filename: "report.md",
  });
  const b = await putFile({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    filename: "data.csv",
  });

  const { project, filesMoved } =
    await projectService.createProjectFromConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    });

  // name defaults to the chat title
  expect(project.name).toBe("Quarterly research");
  expect(filesMoved).toBe(2);

  // the chat now lives in the project
  const meta = await ConversationModel.getOwnedMeta({
    id: conv.id,
    userId: user.id,
    organizationId: org.id,
  });
  expect(meta?.projectId).toBe(project.id);

  // both files now belong to the project
  const projectFiles = await FileModel.listByProject({
    organizationId: org.id,
    projectId: project.id,
  });
  expect(projectFiles.map((f) => f.id).sort()).toEqual([a.id, b.id].sort());
});

test("uses an explicit name over the chat title", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
    title: "default title",
  });

  const { project } = await projectService.createProjectFromConversation({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    name: "Chosen name",
  });
  expect(project.name).toBe("Chosen name");
});

test("an empty chat converts with zero files moved", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });

  const { project, filesMoved } =
    await projectService.createProjectFromConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    });
  expect(filesMoved).toBe(0);
  expect(await ProjectModel.findById(project.id)).not.toBeNull();
});

test("rejects a chat that is not owned by the caller with 404", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser({});
  const other = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: owner.id,
    organizationId: org.id,
  });

  await expect(
    projectService.createProjectFromConversation({
      organizationId: org.id,
      userId: other.id,
      conversationId: conv.id,
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
});

test("rejects a chat already in a project with 409", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });
  await projectService.createProjectFromConversation({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
  });

  await expect(
    projectService.createProjectFromConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

test("rejects a non-user (scheduled-run) chat with 409", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });
  await db
    .update(schema.conversationsTable)
    .set({ origin: "schedule_trigger" })
    .where(eq(schema.conversationsTable.id, conv.id));

  await expect(
    projectService.createProjectFromConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

test("rejects a duplicate project name with 409", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  await projectService.create({
    organizationId: org.id,
    userId: user.id,
    name: "Taken",
    description: null,
  });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
    title: "Taken",
  });

  await expect(
    projectService.createProjectFromConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

test("does not move files that already belong to another project", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const other = await projectService.create({
    organizationId: org.id,
    userId: user.id,
    name: "Other project",
    description: null,
  });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });
  const owned = await putFile({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    filename: "shared.md",
    projectId: other.id,
  });
  const personal = await putFile({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    filename: "mine.md",
  });

  const { project, filesMoved } =
    await projectService.createProjectFromConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    });

  expect(filesMoved).toBe(1);
  expect((await FileModel.findById(owned.id))?.projectId).toBe(other.id);
  expect((await FileModel.findById(personal.id))?.projectId).toBe(project.id);
});

test("leaves the chat's attachments untouched", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });
  await ConversationAttachmentModel.create({
    organizationId: org.id,
    conversationId: conv.id,
    uploadedByUserId: user.id,
    originalName: "notes.pdf",
    mimeType: "application/pdf",
    fileSize: 3,
    contentHash: "hash-attach",
    fileData: Buffer.from("abc"),
    textPreview: null,
    textPreviewStatus: "unsupported",
  });

  await projectService.createProjectFromConversation({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
  });

  const attachments =
    await ConversationAttachmentModel.findByConversationIdWithoutData(conv.id);
  expect(attachments).toHaveLength(1);
  expect(attachments[0].originalName).toBe("notes.pdf");
});

test("converting a shared chat keeps the share and moves its files", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });
  await putFile({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    filename: "report.md",
  });
  await ConversationShareModel.upsert({
    conversationId: conv.id,
    organizationId: org.id,
    createdByUserId: user.id,
    visibility: "organization",
    teamIds: [],
    userIds: [],
  });

  const { project, filesMoved } =
    await projectService.createProjectFromConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    });

  expect(filesMoved).toBe(1);
  const share = await ConversationShareModel.findByConversationId({
    conversationId: conv.id,
    organizationId: org.id,
  });
  expect(share).not.toBeNull();
  const projectFiles = await FileModel.listByProject({
    organizationId: org.id,
    projectId: project.id,
  });
  expect(projectFiles).toHaveLength(1);
});

test("moves only the converter's own files, leaving a collaborator's behind", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const collaborator = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });
  // In a shared chat a collaborator can author no-project files in the owner's
  // conversation. Converting must not sweep those into the owner's private
  // project (which would strip the author's access).
  const mine = await putFile({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    filename: "mine.md",
  });
  const theirs = await putFile({
    organizationId: org.id,
    userId: collaborator.id,
    conversationId: conv.id,
    filename: "theirs.md",
  });

  const { project, filesMoved } =
    await projectService.createProjectFromConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    });

  expect(filesMoved).toBe(1);
  expect((await FileModel.findById(mine.id))?.projectId).toBe(project.id);
  // The collaborator's file stays a no-project file they still own.
  expect((await FileModel.findById(theirs.id))?.projectId).toBeNull();
});

// Exercise ApiError so the import is used even if assertions above use toMatchObject.
test("surfaces failures as ApiError", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });
  await projectService.createProjectFromConversation({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
  });
  const err = await projectService
    .createProjectFromConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
});
