import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("promote a chat attachment into the knowledge repository", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  async function bootAs(actor: User, orgId: string) {
    if (app) await app.close();
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = orgId;
      (request as typeof request & { user: User }).user = actor;
    });
    const { default: knowledgeFileRoutes } = await import(
      "./knowledge-file.routes"
    );
    await app.register(knowledgeFileRoutes);
  }

  /** A conversation owned by `ownerId`, with one text attachment on it. */
  async function makeAttachment(params: {
    ownerId: string;
    orgId: string;
    body?: string;
    originalName?: string;
  }) {
    const [conversation] = await db
      .insert(schema.conversationsTable)
      .values({ userId: params.ownerId, organizationId: params.orgId })
      .returning();

    const fileData = Buffer.from(
      params.body ?? "Retention is 90 days.",
      "utf-8",
    );
    const [attachment] = await db
      .insert(schema.conversationAttachmentsTable)
      .values({
        organizationId: params.orgId,
        conversationId: conversation.id,
        uploadedByUserId: params.ownerId,
        originalName: params.originalName ?? "retention.txt",
        mimeType: "text/plain",
        fileSize: fileData.byteLength,
        contentHash: `hash-${conversation.id}`,
        fileData,
      })
      .returning();

    return { conversation, attachment };
  }

  function promote(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/knowledge-files/from-attachment",
      payload,
    });
  }

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await bootAs(user, organizationId);
  });

  afterEach(async () => {
    await app.close();
  });

  test("copies the attachment into the repository", async () => {
    const { attachment } = await makeAttachment({
      ownerId: user.id,
      orgId: organizationId,
    });

    const response = await promote({ attachmentId: attachment.id });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      filename: "retention.txt",
      mimeType: "text/plain",
      visibility: "org-wide",
      knowledgeBases: [],
    });
  });

  test("stores the bytes, so deleting the chat cannot empty the document", async () => {
    const { attachment } = await makeAttachment({
      ownerId: user.id,
      orgId: organizationId,
      body: "Backups are encrypted at rest.",
    });

    const { id } = (await promote({ attachmentId: attachment.id })).json();

    const content = await app.inject({
      method: "GET",
      url: `/api/knowledge-files/${id}/content`,
    });
    expect(content.body).toContain("Backups are encrypted at rest.");
  });

  test("takes an override name", async () => {
    const { attachment } = await makeAttachment({
      ownerId: user.id,
      orgId: organizationId,
    });

    const response = await promote({
      attachmentId: attachment.id,
      filename: "Data retention policy.txt",
    });

    expect(response.json()).toMatchObject({
      filename: "Data retention policy.txt",
    });
  });

  test("refuses an attachment whose conversation the caller cannot read", async ({
    makeUser,
  }) => {
    const stranger = await makeUser({ email: "stranger@test.com" });
    const { attachment } = await makeAttachment({
      ownerId: stranger.id,
      orgId: organizationId,
    });

    // Someone else's personal chat. Allowing this would let anyone who can
    // create knowledge files copy it out — and publish it org-wide.
    const response = await promote({ attachmentId: attachment.id });

    expect(response.statusCode).toBe(403);
  });

  test("refuses an attachment from another organization", async ({
    makeOrganization,
    makeUser,
  }) => {
    const otherOrg = await makeOrganization();
    const otherUser = await makeUser({ email: "other-org@test.com" });
    const { attachment } = await makeAttachment({
      ownerId: otherUser.id,
      orgId: otherOrg.id,
    });

    const response = await promote({ attachmentId: attachment.id });

    // 404 rather than 403: a caller must not learn that the id exists.
    expect(response.statusCode).toBe(404);
  });

  test("refuses a file the repository cannot read", async () => {
    const { attachment } = await makeAttachment({
      ownerId: user.id,
      orgId: organizationId,
      originalName: "diagram.png",
    });

    // Chat accepts images; the repository cannot index one, and storing it
    // would look indexed and retrieve nothing.
    const response = await promote({ attachmentId: attachment.id });

    expect(response.statusCode).toBe(400);
  });

  test("rejects a second copy under the same name in the same place", async () => {
    const first = await makeAttachment({
      ownerId: user.id,
      orgId: organizationId,
    });
    const second = await makeAttachment({
      ownerId: user.id,
      orgId: organizationId,
    });

    await promote({ attachmentId: first.attachment.id });
    const response = await promote({ attachmentId: second.attachment.id });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("retention.txt");
  });
});
