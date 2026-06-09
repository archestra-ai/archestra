import ConversationAttachmentModel from "@/models/conversation-attachment";
import SkillSandboxModel from "@/models/skill-sandbox";
import SkillSandboxFileModel from "@/models/skill-sandbox-file";
import { conversationFilesService } from "@/services/conversation-files";
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
  const artifact = await SkillSandboxFileModel.createArtifact({
    sandboxId: sandbox.id,
    path: "/home/sandbox/sub/chart.png",
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
  });
  expect(result.attachments).toEqual([]);
});
