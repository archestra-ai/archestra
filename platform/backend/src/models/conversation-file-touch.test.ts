import ConversationFileTouchModel from "@/models/conversation-file-touch";
import FileModel from "@/models/file";
import { expect, test } from "@/test";

async function makeFile(params: {
  organizationId: string;
  userId: string;
  filename: string;
}) {
  return FileModel.create({
    organizationId: params.organizationId,
    userId: params.userId,
    projectId: null,
    conversationId: null,
    filename: params.filename,
    mimeType: "text/plain",
    sizeBytes: 1,
    data: Buffer.from("x"),
  });
}

test("recordTouch is idempotent per (conversation, file)", async ({
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
  const file = await makeFile({
    organizationId: org.id,
    userId: user.id,
    filename: "a.txt",
  });

  await ConversationFileTouchModel.recordTouch({
    organizationId: org.id,
    conversationId: conv.id,
    fileId: file.id,
    touchKind: "read",
  });
  // a second touch (even a different kind) must not create a duplicate row
  await ConversationFileTouchModel.recordTouch({
    organizationId: org.id,
    conversationId: conv.id,
    fileId: file.id,
    touchKind: "edit",
  });

  const referenced = await ConversationFileTouchModel.listReferencedFiles({
    organizationId: org.id,
    conversationId: conv.id,
    scope: { kind: "personal", userId: user.id },
  });
  expect(referenced.map((f) => f.id)).toEqual([file.id]);
});

test("listReferencedFiles drops files that were deleted", async ({
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
  const kept = await makeFile({
    organizationId: org.id,
    userId: user.id,
    filename: "kept.txt",
  });
  const gone = await makeFile({
    organizationId: org.id,
    userId: user.id,
    filename: "gone.txt",
  });

  for (const file of [kept, gone]) {
    await ConversationFileTouchModel.recordTouch({
      organizationId: org.id,
      conversationId: conv.id,
      fileId: file.id,
      touchKind: "read",
    });
  }
  // deleting the file cascades the touch row away
  await FileModel.deleteById(gone.id);

  const referenced = await ConversationFileTouchModel.listReferencedFiles({
    organizationId: org.id,
    conversationId: conv.id,
    scope: { kind: "personal", userId: user.id },
  });
  expect(referenced.map((f) => f.id)).toEqual([kept.id]);
});
