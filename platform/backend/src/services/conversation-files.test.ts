import ConversationModel from "@/models/conversation";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import SkillSandboxModel from "@/models/skill-sandbox";
import { conversationFilesService } from "@/services/conversation-files";
import { projectService } from "@/services/project";
import { fileStore } from "@/skills-sandbox/file-store";
import { expect, test } from "@/test";

test("conversationFilesService.list groups generated + attachments with basenamed names and content URLs", async ({
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

  const sandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    defaultCwd: "/home/sandbox",
    isDefault: true,
  });
  const artifact = await fileStore.put({
    organizationId: org.id,
    userId: user.id,
    projectId: null,
    conversationId: conv.id,
    sandboxId: sandbox.id,
    filename: "chart.png",
    mimeType: "image/png",
    sizeBytes: 3,
    data: Buffer.from("abc"),
  });
  const attachment = await ConversationAttachmentModel.create({
    organizationId: org.id,
    conversationId: conv.id,
    uploadedByUserId: user.id,
    originalName: "notes.pdf",
    mimeType: "application/pdf",
    fileSize: 3,
    contentHash: "hash-1",
    fileData: Buffer.from("abc"),
    textPreview: null,
    textPreviewStatus: "unsupported",
  });

  const result = await conversationFilesService.list({
    conversationId: conv.id,
    organizationId: org.id,
    requestingUserId: user.id,
  });

  expect(result.generated).toEqual([
    {
      id: artifact.id,
      name: "chart.png",
      mimeType: "image/png",
      contentUrl: `/api/skill-sandbox/artifacts/${artifact.id}`,
      createdAt: artifact.createdAt.toISOString(),
    },
  ]);
  expect(result.attachments).toEqual([
    {
      id: attachment.id,
      name: "notes.pdf",
      mimeType: "application/pdf",
      contentUrl: `/api/chat/attachments/${attachment.id}/content`,
      createdAt: attachment.createdAt.toISOString(),
    },
  ]);
  // a personal chat has no project, so no project files section
  expect(result.projectFiles).toEqual([]);
  expect(result.projectName).toBeNull();
});

test("conversationFilesService.list drops attachments from a different org", async ({
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
    organizationId: "org-other",
    conversationId: conv.id,
    uploadedByUserId: user.id,
    originalName: "leak.txt",
    mimeType: "text/plain",
    fileSize: 1,
    contentHash: "hash-2",
    fileData: Buffer.from("x"),
    textPreview: null,
    textPreviewStatus: "ok",
  });

  const result = await conversationFilesService.list({
    conversationId: conv.id,
    organizationId: org.id,
    requestingUserId: user.id,
  });
  expect(result.attachments).toEqual([]);
});

test("personal chat: projectFiles is empty even when the user has files in other chats", async ({
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
  const convSandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    defaultCwd: "/home/sandbox",
    isDefault: true,
  });
  const ownOutput = await fileStore.put({
    organizationId: org.id,
    userId: user.id,
    projectId: null,
    conversationId: conv.id,
    sandboxId: convSandbox.id,
    filename: "here.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    data: Buffer.from("a"),
  });

  // a personal file produced in some OTHER conversation. No-project files are
  // conversation-scoped, and a personal chat has no project files section, so
  // it must not surface here.
  const otherConv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });
  const otherSandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: user.id,
    conversationId: otherConv.id,
    defaultCwd: "/home/sandbox",
  });
  await fileStore.put({
    organizationId: org.id,
    userId: user.id,
    projectId: null,
    conversationId: otherConv.id,
    sandboxId: otherSandbox.id,
    filename: "elsewhere.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    data: Buffer.from("b"),
  });

  const result = await conversationFilesService.list({
    conversationId: conv.id,
    organizationId: org.id,
    requestingUserId: user.id,
  });
  expect(result.generated.map((f) => f.id)).toEqual([ownOutput.id]);
  expect(result.projectFiles).toEqual([]);
  expect(result.projectName).toBeNull();
});

test("project chat: projectFiles is every project file (any author, any chat), for any reader with access", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser({});
  const member = await makeUser({ email: "files-member@test.com" });
  const agent = await makeAgent({ organizationId: org.id });

  const project = await projectService.create({
    organizationId: org.id,
    userId: owner.id,
    name: "filespanel",
    description: null,
  });
  // shared org-wide: the member legitimately has project access, which is what
  // lets them have a chat here and read the project's files.
  await projectService.setShare({
    id: project.id,
    organizationId: org.id,
    userId: owner.id,
    visibility: "organization",
    teamIds: [],
  });
  const conv = await ConversationModel.create({
    userId: member.id,
    organizationId: org.id,
    agentId: agent.id,
    projectId: project.id,
  });

  const ownerSandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: owner.id,
    conversationId: null,
    defaultCwd: "/home/sandbox",
  });
  // a project file with no originating conversation
  const looseFile = await fileStore.put({
    organizationId: org.id,
    userId: owner.id,
    projectId: project.id,
    conversationId: null,
    sandboxId: ownerSandbox.id,
    filename: "result.txt",
    mimeType: "text/plain",
    sizeBytes: 2,
    data: Buffer.from("in"),
  });
  // a project file authored in a DIFFERENT conversation of the project — it
  // must still appear in this chat's project files section.
  const otherConv = await ConversationModel.create({
    userId: owner.id,
    organizationId: org.id,
    agentId: agent.id,
    projectId: project.id,
  });
  const otherChatSandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: owner.id,
    conversationId: otherConv.id,
    defaultCwd: "/home/sandbox",
  });
  const fromOtherChat = await fileStore.put({
    organizationId: org.id,
    userId: owner.id,
    projectId: project.id,
    conversationId: otherConv.id,
    sandboxId: otherChatSandbox.id,
    filename: "other-chat.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    data: Buffer.from("out"),
  });
  // a file generated in THIS chat: it surfaces under `generated`, not duplicated
  // into projectFiles.
  const thisChatSandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: member.id,
    conversationId: conv.id,
    defaultCwd: "/home/sandbox",
    isDefault: true,
  });
  const ownOutput = await fileStore.put({
    organizationId: org.id,
    userId: member.id,
    projectId: project.id,
    conversationId: conv.id,
    sandboxId: thisChatSandbox.id,
    filename: "mine.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    data: Buffer.from("m"),
  });

  const result = await conversationFilesService.list({
    conversationId: conv.id,
    organizationId: org.id,
    requestingUserId: member.id,
  });

  expect(result.generated.map((f) => f.id)).toEqual([ownOutput.id]);
  // every project file except this chat's own output, regardless of author or
  // originating conversation
  expect(result.projectFiles.map((f) => f.id).sort()).toEqual(
    [looseFile.id, fromOtherChat.id].sort(),
  );
  expect(result.projectFiles).toContainEqual({
    id: looseFile.id,
    name: "result.txt",
    mimeType: "text/plain",
    contentUrl: `/api/skill-sandbox/artifacts/${looseFile.id}`,
    createdAt: looseFile.createdAt.toISOString(),
  });
  expect(result.projectName).toBe("filespanel");
});

test("project chat: a requester without project access sees no project files", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser({});
  const outsider = await makeUser({ email: "files-outsider@test.com" });
  const agent = await makeAgent({ organizationId: org.id });

  const project = await projectService.create({
    organizationId: org.id,
    userId: owner.id,
    name: "locked",
    description: null,
  });
  const sandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: owner.id,
    conversationId: null,
    defaultCwd: "/home/sandbox",
  });
  await fileStore.put({
    organizationId: org.id,
    userId: owner.id,
    projectId: project.id,
    conversationId: null,
    sandboxId: sandbox.id,
    filename: "secret.txt",
    mimeType: "text/plain",
    sizeBytes: 2,
    data: Buffer.from("hi"),
  });
  // the outsider owns a chat in the project but the project is unshared (e.g.
  // access was revoked) — the project's files must stay out of reach because
  // resolveProjectFileScope fails closed.
  const conv = await ConversationModel.create({
    userId: outsider.id,
    organizationId: org.id,
    agentId: agent.id,
    projectId: project.id,
  });

  const result = await conversationFilesService.list({
    conversationId: conv.id,
    organizationId: org.id,
    requestingUserId: outsider.id,
  });
  expect(result.projectFiles).toEqual([]);
  expect(result.projectName).toBeNull();
});
