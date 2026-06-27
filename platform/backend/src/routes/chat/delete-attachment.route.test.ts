import ConversationModel from "@/models/conversation";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { conversationFilesService } from "@/services/conversation-files";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

async function seedAttachment(params: {
  conversationId: string;
  organizationId: string;
  uploadedByUserId: string;
}) {
  const bytes = Buffer.from("attachment-bytes", "utf8");
  return ConversationAttachmentModel.create({
    organizationId: params.organizationId,
    conversationId: params.conversationId,
    uploadedByUserId: params.uploadedByUserId,
    originalName: "doc.pdf",
    mimeType: "application/pdf",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });
}

describe("DELETE /api/chat/attachments/:id", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    currentUser = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test("the conversation owner soft-deletes an attachment; it leaves the listing", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
    });
    const attachment = await seedAttachment({
      conversationId: conversation.id,
      organizationId,
      uploadedByUserId: currentUser.id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chat/attachments/${attachment.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    // Soft-deleted: the metadata finder filters deletedAt, and the row no longer
    // appears for the conversation.
    expect(
      await ConversationAttachmentModel.findById(attachment.id),
    ).toBeNull();
    const remaining =
      await ConversationAttachmentModel.findByConversationIdWithoutData(
        conversation.id,
      );
    expect(remaining.map((a) => a.id)).not.toContain(attachment.id);
  });

  test("a non-owner who can otherwise read the chat cannot delete its attachment", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const owner = await makeUser({ email: "att-owner@test.com" });
    await makeMember(owner.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "personal",
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
    });
    const attachment = await seedAttachment({
      conversationId: conversation.id,
      organizationId,
      uploadedByUserId: owner.id,
    });

    // The request runs as currentUser (not the conversation owner).
    const response = await app.inject({
      method: "DELETE",
      url: `/api/chat/attachments/${attachment.id}`,
    });

    expect(response.statusCode).toBe(403);
    // Untouched.
    expect(
      await ConversationAttachmentModel.findById(attachment.id),
    ).not.toBeNull();
  });

  test("an attachment from another org is rejected", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrg = (await makeOrganization()).id;
    const agent = await makeAgent({
      organizationId: otherOrg,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId: otherOrg,
      agentId: agent.id,
    });
    const attachment = await seedAttachment({
      conversationId: conversation.id,
      organizationId: otherOrg,
      uploadedByUserId: currentUser.id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chat/attachments/${attachment.id}`,
    });

    expect(response.statusCode).toBe(403);
    expect(
      await ConversationAttachmentModel.findById(attachment.id),
    ).not.toBeNull();
  });

  test("a missing attachment is a 404", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/chat/attachments/11111111-1111-4111-8111-111111111111",
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("conversationFilesService.list canManageFiles", () => {
  test("is true for the owner and false for a non-owner", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const owner = await makeUser();
    const organizationId = (await makeOrganization()).id;
    await makeMember(owner.id, organizationId, { role: "admin" });
    const viewer = await makeUser({ email: "viewer@test.com" });
    await makeMember(viewer.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "personal",
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
    });

    const asOwner = await conversationFilesService.list({
      conversationId: conversation.id,
      organizationId,
      requestingUserId: owner.id,
    });
    expect(asOwner.canManageFiles).toBe(true);

    const asViewer = await conversationFilesService.list({
      conversationId: conversation.id,
      organizationId,
      requestingUserId: viewer.id,
    });
    expect(asViewer.canManageFiles).toBe(false);
  });
});
