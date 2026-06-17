import config from "@/config";
import ConversationModel from "@/models/conversation";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import FileModel from "@/models/file";
import SkillSandboxModel from "@/models/skill-sandbox";
import SkillSandboxReplayEventModel from "@/models/skill-sandbox-replay-event";
import { conversationFilesService } from "@/services/conversation-files";
import { projectService } from "@/services/project";
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
  const artifact = await FileModel.create({
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
    conversationOwnerUserId: user.id,
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
  // the conversation's own output is a PFS row too — deduped out of myFiles
  expect(result.myFiles).toEqual([]);
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
    conversationOwnerUserId: user.id,
    requestingUserId: user.id,
  });
  expect(result.attachments).toEqual([]);
});

test("personal chat: myFiles is the owner's whole PFS minus this chat's outputs, owner-only", async ({
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
  const ownOutput = await FileModel.create({
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
  // sandbox uploads (my_file pulls included) are not PFS rows — never listed
  await SkillSandboxReplayEventModel.appendUpload({
    sandboxId: convSandbox.id,
    userId: user.id,
    path: "/home/sandbox/from-pfs.csv",
    mimeType: "text/csv",
    originalName: "q2.csv",
    sizeBytes: 4,
    data: Buffer.from("a,b\n"),
    origin: "my_file",
  });

  // a PFS file produced in some OTHER conversation
  const otherSandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: user.id,
    conversationId: null,
    defaultCwd: "/home/sandbox",
  });
  const elsewhere = await FileModel.create({
    organizationId: org.id,
    userId: user.id,
    projectId: null,
    conversationId: null,
    sandboxId: otherSandbox.id,
    filename: "elsewhere.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    data: Buffer.from("b"),
  });

  const result = await conversationFilesService.list({
    conversationId: conv.id,
    organizationId: org.id,
    conversationOwnerUserId: user.id,
    requestingUserId: user.id,
  });
  expect(result.generated.map((f) => f.id)).toEqual([ownOutput.id]);
  expect(result.myFiles).toEqual([
    {
      id: elsewhere.id,
      name: "elsewhere.txt",
      mimeType: "text/plain",
      contentUrl: `/api/skill-sandbox/artifacts/${elsewhere.id}`,
      createdAt: elsewhere.createdAt.toISOString(),
    },
  ]);

  // a non-owner reading the shared chat must not see the owner's personal PFS
  const viewer = await makeUser({ email: "files-viewer@test.com" });
  const viewerResult = await conversationFilesService.list({
    conversationId: conv.id,
    organizationId: org.id,
    conversationOwnerUserId: user.id,
    requestingUserId: viewer.id,
  });
  expect(viewerResult.myFiles).toEqual([]);
});

test("project chat: myFiles is the project's files, for any reader", async ({
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
  const projectFile = await FileModel.create({
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
  // the owner's personal file must stay invisible in a project chat
  await FileModel.create({
    organizationId: org.id,
    userId: owner.id,
    projectId: null,
    conversationId: null,
    sandboxId: ownerSandbox.id,
    filename: "personal.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    data: Buffer.from("out"),
  });

  const result = await conversationFilesService.list({
    conversationId: conv.id,
    organizationId: org.id,
    conversationOwnerUserId: member.id,
    requestingUserId: member.id,
  });
  expect(result.myFiles).toEqual([
    {
      id: projectFile.id,
      name: "result.txt",
      mimeType: "text/plain",
      contentUrl: `/api/skill-sandbox/artifacts/${projectFile.id}`,
      createdAt: projectFile.createdAt.toISOString(),
    },
  ]);
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
  await FileModel.create({
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
  // access was revoked) — the project's files must stay out of reach.
  const conv = await ConversationModel.create({
    userId: outsider.id,
    organizationId: org.id,
    agentId: agent.id,
    projectId: project.id,
  });

  const result = await conversationFilesService.list({
    conversationId: conv.id,
    organizationId: org.id,
    conversationOwnerUserId: outsider.id,
    requestingUserId: outsider.id,
  });
  expect(result.myFiles).toEqual([]);
  expect(result.projectName).toBeNull();
});

test("projects off: myFiles is empty and projectName null, generated still shown", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const original = config.projects.enabled;
  (config.projects as { enabled: boolean }).enabled = false;
  try {
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
    // this chat's own output — still surfaces under `generated`
    const ownOutput = await FileModel.create({
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
    // a PFS file from another conversation — would normally appear in myFiles
    const otherSandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    await FileModel.create({
      organizationId: org.id,
      userId: user.id,
      projectId: null,
      conversationId: null,
      sandboxId: otherSandbox.id,
      filename: "elsewhere.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      data: Buffer.from("b"),
    });

    const result = await conversationFilesService.list({
      conversationId: conv.id,
      organizationId: org.id,
      conversationOwnerUserId: user.id,
      requestingUserId: user.id,
    });
    expect(result.generated.map((f) => f.id)).toEqual([ownOutput.id]);
    expect(result.myFiles).toEqual([]);
    expect(result.projectName).toBeNull();
  } finally {
    (config.projects as { enabled: boolean }).enabled = original;
  }
});
