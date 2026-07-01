import { ChatErrorCode } from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import ConversationChatErrorModel from "@/models/conversation-chat-error";
import MessageModel from "@/models/message";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("chat conversation and message routes", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    currentUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates a conversation for an accessible agent", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: {
        agentId: agent.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: expect.any(String),
      agentId: agent.id,
      pinnedAt: null,
    });
  });

  test("pins and unpins a conversation", async ({ makeAgent }) => {
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

    const pinnedAt = new Date().toISOString();
    const pinResponse = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversation.id}`,
      payload: { pinnedAt },
    });

    expect(pinResponse.statusCode).toBe(200);
    expect(pinResponse.json().pinnedAt).not.toBeNull();

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}`,
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().pinnedAt).not.toBeNull();

    const unpinResponse = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversation.id}`,
      payload: { pinnedAt: null },
    });

    expect(unpinResponse.statusCode).toBe(200);
    expect(unpinResponse.json().pinnedAt).toBeNull();
  });

  test("marking a conversation read clears its unread flag in the list", async ({
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
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: { role: "assistant", parts: [{ type: "text", text: "hi" }] },
    });

    const before = await app.inject({
      method: "GET",
      url: "/api/chat/conversations",
    });
    expect(before.json()[0].unread).toBe(true);
    // The owner's private read marker must never reach the client (a shared
    // viewer would otherwise see when the owner last read the chat).
    expect(before.json()[0]).not.toHaveProperty("lastReadAt");

    const readResponse = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/read`,
    });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json()).toEqual({ success: true });

    const after = await app.inject({
      method: "GET",
      url: "/api/chat/conversations",
    });
    expect(after.json()[0].unread).toBe(false);
  });

  test("marking an unknown conversation read returns 404", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations/00000000-0000-4000-8000-000000000000/read",
    });
    expect(response.statusCode).toBe(404);
  });

  test("rejects a conversation update that sets a model without an API key", async ({
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

    const response = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversation.id}`,
      payload: { modelId: crypto.randomUUID() },
    });

    expect(response.statusCode).toBe(400);
  });

  test("allows scheduled task admins to view linked run conversations owned by another user", async ({
    makeAgent,
    makeMember,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeUser,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "org",
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      agentId: agent.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, {
      organizationId,
      runKind: "due",
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        id: "message-1",
        role: "assistant",
        parts: [{ type: "text", text: "Scheduled run complete" }],
      },
    });
    await ScheduleTriggerRunModel.setChatConversationId(
      run.id,
      conversation.id,
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: conversation.id,
      userId: owner.id,
      messages: [
        expect.objectContaining({
          id: expect.any(String),
          parts: [{ type: "text", text: "Scheduled run complete" }],
        }),
      ],
    });
  });

  test("keeps the project link when forking own conversation in a project", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const project = await projectService.create({
      organizationId,
      userId: currentUser.id,
      name: "own-project",
      description: null,
    });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
      projectId: project.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/fork`,
      payload: { agentId: agent.id },
    });

    expect(response.statusCode).toBe(200);
    // The owner can always access their own project, so the fork stays in it.
    expect(response.json().projectId).toBe(project.id);
  });

  test("forks an accessible scheduled run conversation for the current user", async ({
    makeAgent,
    makeMember,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeUser,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "org",
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      agentId: agent.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, {
      organizationId,
      runKind: "due",
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        id: "message-1",
        role: "assistant",
        parts: [{ type: "text", text: "Scheduled run complete" }],
      },
    });
    await ScheduleTriggerRunModel.setChatConversationId(
      run.id,
      conversation.id,
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/fork`,
      payload: {
        agentId: agent.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: agent.id,
      userId: currentUser.id,
      messages: [
        expect.objectContaining({
          id: expect.any(String),
          parts: [{ type: "text", text: "Scheduled run complete" }],
        }),
      ],
    });
  });

  test("returns 404 when non-admin member forks another user's scheduled run conversation", async ({
    makeAgent,
    makeMember,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeUser,
  }) => {
    const owner = await makeUser();
    const member = await makeUser();
    await makeMember(owner.id, organizationId, { role: "member" });
    await makeMember(member.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "org",
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      agentId: agent.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, {
      organizationId,
      runKind: "due",
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
    });
    await ScheduleTriggerRunModel.setChatConversationId(
      run.id,
      conversation.id,
    );

    currentUser = member;

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/fork`,
      payload: {
        agentId: agent.id,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Conversation not found");
  });

  test("forking a conversation with an attachment clones the row scoped to the fork and rewrites the ref", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const source = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
    });
    const bytes = Buffer.from("integration-test-bytes", "utf8");
    const sourceRow = await ConversationAttachmentModel.create({
      organizationId,
      conversationId: source.id,
      uploadedByUserId: currentUser.id,
      originalName: "doc.pdf",
      mimeType: "application/pdf",
      fileSize: bytes.byteLength,
      contentHash: ConversationAttachmentModel.computeContentHash(bytes),
      fileData: bytes,
    });
    await ConversationAttachmentModel.updateTextPreview(
      sourceRow.id,
      "ok",
      "INTEGRATION_PREVIEW",
    );
    await MessageModel.create({
      conversationId: source.id,
      role: "user",
      content: {
        id: "message-1",
        role: "user",
        parts: [
          { type: "text", text: "look at this" },
          {
            type: "file",
            url: `/api/chat/attachments/${sourceRow.id}/content`,
            mediaType: "application/pdf",
            filename: "doc.pdf",
            fileSize: bytes.byteLength,
          },
        ],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${source.id}/fork`,
      payload: { agentId: agent.id },
    });

    expect(response.statusCode).toBe(200);
    const forkBody = response.json();
    expect(forkBody.userId).toBe(currentUser.id);
    expect(forkBody.id).not.toBe(source.id);

    // Locate the file part on the forked message; assert it points at a NEW
    // ref id, not the source attachment's id.
    const forkedFilePart = forkBody.messages[0].parts.find(
      (p: { type: string }) => p.type === "file",
    );
    expect(forkedFilePart).toBeDefined();
    expect(forkedFilePart.url).not.toBe(
      `/api/chat/attachments/${sourceRow.id}/content`,
    );
    const newIdMatch = (forkedFilePart.url as string).match(
      /\/api\/chat\/attachments\/([^/]+)\/content/,
    );
    expect(newIdMatch).not.toBeNull();
    const newId = newIdMatch?.[1] as string;
    expect(newId).not.toBe(sourceRow.id);

    // The cloned row is scoped to the FORK conversation with identical bytes.
    const clonedRow = await ConversationAttachmentModel.findByIdWithData(newId);
    expect(clonedRow).not.toBeNull();
    expect(clonedRow?.conversationId).toBe(forkBody.id);
    expect(clonedRow?.organizationId).toBe(organizationId);
    expect(clonedRow?.uploadedByUserId).toBe(currentUser.id);
    expect(clonedRow?.contentHash).toBe(sourceRow.contentHash);
    expect(clonedRow?.fileData.equals(bytes)).toBe(true);
    expect(clonedRow?.textPreview).toBe("INTEGRATION_PREVIEW");

    // Source attachment is untouched — fork is a copy, not a move.
    const stillSource = await ConversationAttachmentModel.findByIdWithData(
      sourceRow.id,
    );
    expect(stillSource?.conversationId).toBe(source.id);
  });

  test("forking a conversation with a crafted cross-conv ref does NOT clone the foreign row (IDOR guard)", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const source = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
    });
    // A different user with a private conversation in the same org.
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, { role: "member" });
    const foreignAgent = await makeAgent({
      organizationId,
      authorId: otherUser.id,
      scope: "personal",
    });
    const foreign = await ConversationModel.create({
      userId: otherUser.id,
      organizationId,
      agentId: foreignAgent.id,
    });
    const secretBytes = Buffer.from("FOREIGN_SECRET", "utf8");
    const foreignRow = await ConversationAttachmentModel.create({
      organizationId,
      conversationId: foreign.id,
      uploadedByUserId: otherUser.id,
      originalName: "secret.bin",
      mimeType: "application/octet-stream",
      fileSize: secretBytes.byteLength,
      contentHash: ConversationAttachmentModel.computeContentHash(secretBytes),
      fileData: secretBytes,
    });

    // Attacker persists a crafted ref to the foreign row inside their own
    // conversation. In production this is reachable: extractInlineAttachments
    // only rewrites `data:` URLs, leaving other urls intact.
    await MessageModel.create({
      conversationId: source.id,
      role: "user",
      content: {
        id: "crafted-1",
        role: "user",
        parts: [
          {
            type: "file",
            url: `/api/chat/attachments/${foreignRow.id}/content`,
            mediaType: "application/octet-stream",
            filename: "crafted.bin",
          },
        ],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${source.id}/fork`,
      payload: { agentId: agent.id },
    });

    expect(response.statusCode).toBe(200);
    const forkBody = response.json();
    const forkedFilePart = forkBody.messages[0].parts.find(
      (p: { type: string }) => p.type === "file",
    );
    // The crafted ref is preserved as-is (not rewritten) — the fork has no
    // own clone of the foreign bytes, so materialize will silently drop it.
    expect(forkedFilePart.url).toBe(
      `/api/chat/attachments/${foreignRow.id}/content`,
    );

    // No attachment row exists scoped to the fork (the foreign bytes did NOT
    // get copied across the conversation boundary).
    const forkAttachments =
      await ConversationAttachmentModel.findByConversationIdWithoutData(
        forkBody.id,
      );
    expect(forkAttachments.length).toBe(0);
  });

  test("returns 404 when forking a missing conversation", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations/00000000-0000-4000-8000-000000000000/fork",
      payload: {
        agentId: agent.id,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Conversation not found");
  });

  test("returns 404 when non-admin member opens another user's scheduled run conversation", async ({
    makeAgent,
    makeMember,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeUser,
  }) => {
    const owner = await makeUser();
    const member = await makeUser();
    await makeMember(owner.id, organizationId, { role: "member" });
    await makeMember(member.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "org",
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      agentId: agent.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, {
      organizationId,
      runKind: "due",
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
    });
    await ScheduleTriggerRunModel.setChatConversationId(
      run.id,
      conversation.id,
    );

    currentUser = member;

    const response = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Conversation not found");
  });

  test("returns 404 when admin opens another user's conversation that is not a scheduled run", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "org",
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Conversation not found");
  });

  test("returns 404 when updating a missing conversation", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/chat/conversations/00000000-0000-4000-8000-000000000000",
      payload: { pinnedAt: new Date().toISOString() },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Conversation not found");
  });

  test("returns 404 when updating a missing message", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/chat/messages/1d6934ea-eb0d-452d-abf3-72122d140c49",
      payload: {
        partIndex: 0,
        text: "Updated text",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Message not found");
  });

  test("validates chat message patch payload", async () => {
    const emptyTextResponse = await app.inject({
      method: "PATCH",
      url: "/api/chat/messages/1d6934ea-eb0d-452d-abf3-72122d140c49",
      payload: {
        partIndex: 0,
        text: "",
      },
    });

    expect(emptyTextResponse.statusCode).toBe(400);

    const negativeIndexResponse = await app.inject({
      method: "PATCH",
      url: "/api/chat/messages/1d6934ea-eb0d-452d-abf3-72122d140c49",
      payload: {
        partIndex: -1,
        text: "Updated text",
      },
    });

    expect(negativeIndexResponse.statusCode).toBe(400);

    const missingBodyResponse = await app.inject({
      method: "PATCH",
      url: "/api/chat/messages/1d6934ea-eb0d-452d-abf3-72122d140c49",
      payload: {},
    });

    expect(missingBodyResponse.statusCode).toBe(400);
  });

  test("updates a message text part and deletes subsequent messages when requested", async ({
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

    const firstMessage = await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-user-1",
        role: "user",
        parts: [{ type: "text", text: "Original text" }],
      },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        id: "temp-assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Follow-up response" }],
      },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/chat/messages/${firstMessage.id}`,
      payload: {
        partIndex: 0,
        text: "Updated text",
        deleteSubsequentMessages: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages).toHaveLength(1);
    expect(response.json().messages[0]).toMatchObject({
      id: firstMessage.id,
      parts: [{ type: "text", text: "Updated text" }],
    });
  });
});

describe("chat conversation creation in projects", () => {
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
  });

  afterEach(async () => {
    await app.close();
  });

  test("a chat created with projectId belongs to the project", async ({
    makeAgent,
  }) => {
    const { projectService } = await import("@/services/project");
    const project = await projectService.create({
      organizationId,
      userId: currentUser.id,
      name: "chat-home",
      description: null,
    });
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: { agentId: agent.id, projectId: project.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ projectId: project.id });
  });

  test("an inaccessible or unknown project 404s", async ({
    makeAgent,
    makeUser,
  }) => {
    const stranger = await makeUser({ email: "proj-chat-stranger@test.com" });
    const { projectService } = await import("@/services/project");
    const theirProject = await projectService.create({
      organizationId,
      userId: stranger.id,
      name: "not-yours",
      description: null,
    });
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });

    const denied = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: { agentId: agent.id, projectId: theirProject.id },
    });
    expect(denied.statusCode).toBe(404);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: {
        agentId: agent.id,
        projectId: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("project chats: read-only access for project members", () => {
  let app: FastifyInstanceWithZod;
  let author: User;
  let actingUser: User;
  let organizationId: string;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    author = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(author.id, organizationId, { role: "admin" });
    actingUser = author;
    agentId = (
      await makeAgent({
        organizationId,
        authorId: author.id,
        scope: "personal",
      })
    ).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = actingUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedProjectChat(params: { shared: boolean }) {
    const { projectService } = await import("@/services/project");
    const { ProjectShareModel } = await import("@/models");
    const project = await projectService.create({
      organizationId,
      userId: author.id,
      name: `ro-${params.shared ? "shared" : "private"}`,
      description: null,
    });
    if (params.shared) {
      await ProjectShareModel.upsert({
        projectId: project.id,
        organizationId,
        createdByUserId: author.id,
        visibility: "organization",
        teamIds: [],
      });
    }
    const conversation = await ConversationModel.create({
      userId: author.id,
      organizationId,
      agentId,
      projectId: project.id,
    });
    return { project, conversation };
  }

  test("a member of a shared project can read the chat but not mutate it", async ({
    makeUser,
    makeMember,
  }) => {
    const { conversation } = await seedProjectChat({ shared: true });
    const member = await makeUser({ email: "ro-member@test.com" });
    await makeMember(member.id, organizationId, {});
    actingUser = member;

    const read = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: conversation.id });

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversation.id}`,
      payload: { title: "hijacked" },
    });
    expect([403, 404]).toContain(rename.statusCode);

    // the delete model call is owner-scoped, so a member's DELETE is a no-op
    // (the route's 200 is pre-existing "idempotent delete" semantics).
    await app.inject({
      method: "DELETE",
      url: `/api/chat/conversations/${conversation.id}`,
    });
    const stillThere = await ConversationModel.findById({
      id: conversation.id,
      userId: author.id,
      organizationId,
    });
    expect(stillThere).not.toBeNull();
  });

  test("chats in unshared projects stay invisible to others", async ({
    makeUser,
    makeMember,
  }) => {
    const { conversation } = await seedProjectChat({ shared: false });
    const outsider = await makeUser({ email: "ro-outsider@test.com" });
    await makeMember(outsider.id, organizationId, {});
    actingUser = outsider;

    const read = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}`,
    });
    expect(read.statusCode).toBe(404);
  });
});

describe("conversation list projectName", () => {
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
  });

  afterEach(async () => {
    await app.close();
  });

  test("project chats carry projectName; plain chats carry null", async ({
    makeAgent,
  }) => {
    const { projectService } = await import("@/services/project");
    const project = await projectService.create({
      organizationId,
      userId: currentUser.id,
      name: "chip-source",
      description: null,
    });
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
      projectId: project.id,
      title: "in project",
    });
    await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
      title: "plain",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/chat/conversations",
    });
    expect(response.statusCode).toBe(200);
    const body =
      response.json<
        Array<{ title: string | null; projectName: string | null }>
      >();
    const byTitle = Object.fromEntries(body.map((c) => [c.title, c]));
    expect(byTitle["in project"].projectName).toBe("chip-source");
    expect(byTitle.plain.projectName).toBeNull();
  });

  test("clears a conversation's recorded chat errors", async ({
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
    await ConversationChatErrorModel.create({
      conversationId: conversation.id,
      error: {
        code: ChatErrorCode.ServerError,
        message: "boom",
        isRetryable: true,
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chat/conversations/${conversation.id}/chat-errors`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(
      await ConversationChatErrorModel.findByConversation(conversation.id),
    ).toHaveLength(0);
  });

  test("returns 404 when clearing chat errors on another user's conversation", async ({
    makeUser,
    makeAgent,
  }) => {
    const otherUser = await makeUser();
    const agent = await makeAgent({
      organizationId,
      authorId: otherUser.id,
      scope: "personal",
    });
    const conversation = await ConversationModel.create({
      userId: otherUser.id,
      organizationId,
      agentId: agent.id,
    });
    await ConversationChatErrorModel.create({
      conversationId: conversation.id,
      error: {
        code: ChatErrorCode.ServerError,
        message: "boom",
        isRetryable: true,
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chat/conversations/${conversation.id}/chat-errors`,
    });

    // Owner-scoped lookup: the current user doesn't own it, so it's 404 and the
    // other user's error is left intact.
    expect(response.statusCode).toBe(404);
    expect(
      await ConversationChatErrorModel.findByConversation(conversation.id),
    ).toHaveLength(1);
  });
});
