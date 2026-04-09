import ConversationModel from "@/models/conversation";
import MessageModel from "@/models/message";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
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
        selectedModel: "gpt-4o",
        selectedProvider: "openai",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: expect.any(String),
      agentId: agent.id,
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
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
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
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
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
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
