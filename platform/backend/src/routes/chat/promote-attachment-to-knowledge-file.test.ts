import { vi } from "vitest";
import { KbUploadedFileModel } from "@/models";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, User } from "@/types";

vi.mock("@/knowledge-base/file-upload/blob-storage-providers", () => {
  const databaseProvider = {
    name: "db",
    put: async (params: { data: Buffer }) => ({
      provider: "db",
      key: null,
      dbData: params.data,
    }),
    get: async (params: { dbData: Buffer | null }) => params.dbData,
    delete: async () => {},
  };

  return {
    getConfiguredBlobStorageProvider: () => databaseProvider,
    getBlobStorageProvider: () => databaseProvider,
  };
});

describe("chat attachment promotion", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let agent: Agent;
  let attachmentId: string;

  beforeEach(
    async ({ makeOrganization, makeUser, makeAgent, makeConversation }) => {
      user = await makeUser();
      const organization = await makeOrganization();
      organizationId = organization.id;
      agent = await makeAgent({
        organizationId,
        agentType: "agent",
        name: "Research Agent",
        teams: [],
      });

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: unknown }).user = user;
        (
          request as typeof request & {
            organizationId: string;
          }
        ).organizationId = organizationId;
      });

      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);

      const conversation = await makeConversation(agent.id, {
        organizationId,
        userId: user.id,
      });
      const bytes = Buffer.from("Reusable chat attachment content", "utf8");
      const attachment = await ConversationAttachmentModel.create({
        organizationId,
        conversationId: conversation.id,
        uploadedByUserId: user.id,
        originalName: "chat-runbook.txt",
        mimeType: "text/plain",
        fileSize: bytes.byteLength,
        contentHash: ConversationAttachmentModel.computeContentHash(bytes),
        fileData: bytes,
        textPreviewStatus: "ok",
        textPreview: "Reusable chat attachment content",
      });
      attachmentId = attachment.id;
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("promotes a readable chat attachment to a Knowledge File", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/chat/attachments/${attachmentId}/promote-to-knowledge-file`,
      payload: {
        visibility: "org",
        teamIds: [],
        agentIds: [agent.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      filename: "chat-runbook.txt",
      status: "created",
    });

    const file = await KbUploadedFileModel.findById(response.json().fileId);
    expect(file).toMatchObject({
      organizationId,
      ownerId: user.id,
      visibility: "org",
      originalName: "chat-runbook.txt",
    });
  });

  test("returns not found when promoting an attachment from an unreadable conversation", async ({
    makeUser,
  }) => {
    user = await makeUser();

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/attachments/${attachmentId}/promote-to-knowledge-file`,
      payload: {
        visibility: "personal",
        teamIds: [],
        agentIds: [],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Attachment not found");
  });

  test("returns not found when promoting an attachment outside the active organization", async ({
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    organizationId = otherOrganization.id;

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/attachments/${attachmentId}/promote-to-knowledge-file`,
      payload: {
        visibility: "personal",
        teamIds: [],
        agentIds: [],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Attachment not found");
  });
});
