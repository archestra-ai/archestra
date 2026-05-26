import {
  ConversationModel,
  ConversationShareModel,
  MessageModel,
} from "@/models";
import ActiveChatRunModel from "@/models/chat-active-run";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("chat active-run routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      user = await makeUser();
      const organization = await makeOrganization();
      organizationId = organization.id;
      const agent = await makeAgent({ organizationId });
      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId,
      });
      conversationId = conversation.id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & {
            organizationId: string;
          }
        ).organizationId = organizationId;
      });

      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("returns 204 when no active run exists", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversationId}/active-run`,
    });

    expect(response.statusCode).toBe(204);
  });

  test("duplicate submit returns 409 when the conversation already has a running active run", async () => {
    await ActiveChatRunModel.create({
      conversationId,
      userId: user.id,
      organizationId,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("active response");
    await expect(
      MessageModel.findByConversation(conversationId),
    ).resolves.toHaveLength(0);
  });

  test("stop marks an accessible running active run with stopRequestedAt", async () => {
    await ActiveChatRunModel.create({
      conversationId,
      userId: user.id,
      organizationId,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversationId}/stop`,
    });

    expect(response.statusCode).toBe(200);
    const run =
      await ActiveChatRunModel.findRunningByConversation(conversationId);
    expect(run?.stopRequestedAt).toBeInstanceOf(Date);
  });

  test("stop returns 404 for an inaccessible conversation and does not mutate a running run", async ({
    makeAgent,
    makeConversation,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    const agent = await makeAgent({ organizationId });
    const inaccessibleConversation = await makeConversation(agent.id, {
      userId: otherUser.id,
      organizationId,
    });
    await ActiveChatRunModel.create({
      conversationId: inaccessibleConversation.id,
      userId: otherUser.id,
      organizationId,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${inaccessibleConversation.id}/stop`,
    });

    expect(response.statusCode).toBe(404);
    const run = await ActiveChatRunModel.findRunningByConversation(
      inaccessibleConversation.id,
    );
    expect(run?.stopRequestedAt).toBeNull();
  });

  test("stop returns 404 when a share-only user tries to stop the owner's stream", async ({
    makeMember,
    makeUser,
  }) => {
    const owner = user;
    await makeMember(owner.id, organizationId);
    const sharee = await makeUser();
    await makeMember(sharee.id, organizationId);

    await ConversationShareModel.upsert({
      conversationId,
      organizationId,
      createdByUserId: owner.id,
      visibility: "user",
      teamIds: [],
      userIds: [sharee.id],
    });
    await ActiveChatRunModel.create({
      conversationId,
      userId: owner.id,
      organizationId,
    });

    // Guard against a silent test-setup regression: if the share stops granting
    // read access, the assertion below would pass for the wrong reason.
    const accessibleAsSharee = await ConversationModel.findAccessibleById({
      id: conversationId,
      userId: sharee.id,
      organizationId,
    });
    expect(accessibleAsSharee).not.toBeNull();

    user = sharee;
    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversationId}/stop`,
    });

    expect(response.statusCode).toBe(404);
    const run =
      await ActiveChatRunModel.findRunningByConversation(conversationId);
    expect(run?.stopRequestedAt).toBeNull();
  });

  test("stop returns 404 for a cross-organization conversation and does not mutate a running run", async ({
    makeAgent,
    makeConversation,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const agent = await makeAgent({ organizationId: otherOrganization.id });
    const crossOrganizationConversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: otherOrganization.id,
    });
    await ActiveChatRunModel.create({
      conversationId: crossOrganizationConversation.id,
      userId: user.id,
      organizationId: otherOrganization.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${crossOrganizationConversation.id}/stop`,
    });

    expect(response.statusCode).toBe(404);
    const run = await ActiveChatRunModel.findRunningByConversation(
      crossOrganizationConversation.id,
    );
    expect(run?.stopRequestedAt).toBeNull();
  });

  test("active-run replays existing events and closes after terminal status", async () => {
    const run = await ActiveChatRunModel.create({
      conversationId,
      userId: user.id,
      organizationId,
    });
    await ActiveChatRunModel.appendEvents({
      runId: run?.id ?? "",
      seq: 1,
      payloads: [
        { type: "start" },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "hello" },
      ],
    });
    await ActiveChatRunModel.markTerminal({
      runId: run?.id ?? "",
      status: "completed",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversationId}/active-run`,
    });

    expect(response.statusCode).toBe(200);
    expect(readSsePayloads(response.body)).toContainEqual({ type: "start" });
    expect(readSsePayloads(response.body)).toContainEqual({
      type: "text-delta",
      id: "text-1",
      delta: "hello",
    });
  });

  test("active-run streams later database events before closing", async () => {
    const run = await ActiveChatRunModel.create({
      conversationId,
      userId: user.id,
      organizationId,
    });

    const responsePromise = app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversationId}/active-run`,
    });

    setTimeout(() => {
      void (async () => {
        await ActiveChatRunModel.appendEvents({
          runId: run?.id ?? "",
          seq: 1,
          payloads: [{ type: "start" }],
        });
        await ActiveChatRunModel.markTerminal({
          runId: run?.id ?? "",
          status: "completed",
        });
      })();
    }, 20);

    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(readSsePayloads(response.body)).toContainEqual({ type: "start" });
  });
});

function readSsePayloads(body: string): unknown[] {
  return body
    .split("\n\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("data: "))
    .map((entry) => entry.slice("data: ".length))
    .filter((entry) => entry !== "[DONE]")
    .map((entry) => JSON.parse(entry));
}
